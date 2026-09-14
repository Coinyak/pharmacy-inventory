// 재고 데이터 API
// GET  /api/state?type=chemo|general  - 데이터 조회 (누구나)
// PUT  /api/state                     - 데이터 저장 (관리자만, 미들웨어에서 인증)

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  if (!type || !['chemo', 'general'].includes(type)) {
    return Response.json({ error: 'type 파라미터 필요 (chemo|general)' }, { status: 400 });
  }

  // 장기 통계 범위 조회
  const statsFrom = url.searchParams.get('stats_from');
  const statsTo = url.searchParams.get('stats_to');
  if (statsFrom && statsTo) {
    try {
      const rows = await env.DB.prepare(
        'SELECT date, stats FROM daily_stats WHERE data_type = ? AND date >= ? AND date <= ? ORDER BY date'
      ).bind(type, statsFrom, statsTo).all();
      return Response.json({ stats: rows.results || [] });
    } catch (e) {
      return Response.json({ error: 'stats 조회 실패: ' + e.message }, { status: 500 });
    }
  }

  const row = await env.DB.prepare(
    'SELECT data, daily_data, updated_at FROM app_state WHERE id = ?'
  ).bind(type).first();

  if (!row) {
    return Response.json({ data: '{}', daily_data: '{}', updated_at: null });
  }

  const since = url.searchParams.get('since');
  if (since && since === row.updated_at) {
    return new Response(null, { status: 304 });
  }

  return Response.json({
    data: row.data,
    daily_data: row.daily_data,
    updated_at: row.updated_at,
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { type, data, daily_data, base_updated_at } = body;

    if (!type || !['chemo', 'general'].includes(type)) {
      return Response.json({ error: 'type 필요' }, { status: 400 });
    }

    // 미들웨어에서 인증된 관리자 타입 확인
    if (!context.data || !context.data.adminType) {
      return Response.json({ error: '인증 필요' }, { status: 401 });
    }
    if (context.data.adminType !== type) {
      return Response.json({ error: '다른 관리자의 데이터는 수정할 수 없습니다.' }, { status: 403 });
    }

    // 데이터 타입 검증: 저장되는 데이터의 _dataType이 요청 type과 일치해야 함
    if (data && data !== '{}') {
      try {
        const parsed = JSON.parse(data);
        if (parsed._dataType && parsed._dataType !== type) {
          return Response.json({ error: '데이터 타입 불일치 (' + parsed._dataType + ' != ' + type + ')' }, { status: 400 });
        }
      } catch(e) { /* JSON 파싱 실패는 무시 */ }
    }

    const current = await env.DB.prepare(
      'SELECT data, daily_data, updated_at FROM app_state WHERE id = ?'
    ).bind(type).first();

    let now = new Date().toISOString();
    // 같은 밀리초에 저장돼도 이전 버전보다 반드시 큰 토큰을 만들기 위해 1ms 보정
    if (base_updated_at && now <= base_updated_at) now = new Date(Date.parse(base_updated_at) + 1).toISOString();

    if (!current) {
      try {
        await env.DB.prepare(
          'INSERT INTO app_state (id, data, daily_data, updated_at) VALUES (?, ?, ?, ?)'
        ).bind(type, data || '{}', daily_data || '{}', now).run();
      } catch (insertErr) {
        const latest = await env.DB.prepare(
          'SELECT data, daily_data, updated_at FROM app_state WHERE id = ?'
        ).bind(type).first();
        if (!latest) throw insertErr;
        return Response.json({
          error: '다른 사용자가 먼저 변경했습니다.',
          data: latest.data || '{}',
          daily_data: latest.daily_data || '{}',
          updated_at: latest.updated_at || null,
        }, { status: 409 });
      }
    } else {
      if (!base_updated_at) {
        return Response.json({ error: '최신 데이터를 다시 불러온 뒤 저장하세요.' }, { status: 428 });
      }

      const updateResult = await env.DB.prepare(
        'UPDATE app_state SET data = ?, daily_data = ?, updated_at = ? WHERE id = ? AND updated_at = ?'
      ).bind(data || '{}', daily_data || '{}', now, type, base_updated_at).run();

      if (!updateResult.meta || updateResult.meta.changes !== 1) {
        const latest = await env.DB.prepare(
          'SELECT data, daily_data, updated_at FROM app_state WHERE id = ?'
        ).bind(type).first();
        if (!latest) {
          await env.DB.prepare(
            'INSERT INTO app_state (id, data, daily_data, updated_at) VALUES (?, ?, ?, ?)'
          ).bind(type, data || '{}', daily_data || '{}', now).run();
        } else {
          return Response.json({
            error: '다른 사용자가 먼저 변경했습니다.',
            data: latest.data || '{}',
            daily_data: latest.daily_data || '{}',
            updated_at: latest.updated_at || null,
          }, { status: 409 });
        }
      }
    }

    // 재고 히스토리 저장 (AI 수요예측용, 365일 보관)
    try {
      if (data && data !== '{}') {
        const parsed = JSON.parse(data);
        const inv = parsed.inventory || [];
        if (inv.length > 0) {
          const summary = inv.map(d => ({
            c: d.code || '',
            n: (d.name || '').substring(0, 40),
            q: d.qty != null ? d.qty : 0
          }));
          const dateKey = now.slice(0, 10);
          await env.DB.prepare(
            'INSERT OR REPLACE INTO inventory_history (data_type, date, summary) VALUES (?, ?, ?)'
          ).bind(type, dateKey, JSON.stringify(summary)).run();

          // 10년 초과 데이터 정리 (재고량 히스토리)
          const cutoff = new Date(Date.now() - 3650 * 86400000).toISOString().slice(0, 10);
          await env.DB.prepare(
            'DELETE FROM inventory_history WHERE data_type = ? AND date < ?'
          ).bind(type, cutoff).run();
        }
      }
    } catch (histErr) {
      console.warn('inventory_history 저장 실패:', histErr);
    }

    // 항암제 일별 통계 저장 (AI 분석용, 365일 보관)
    try {
      if (type === 'chemo' && body.chemo_stats) {
        const stats = JSON.parse(body.chemo_stats);
        if (stats && stats.d) {
          await env.DB.prepare(
            'INSERT OR REPLACE INTO chemo_daily_stats (date, stats) VALUES (?, ?)'
          ).bind(stats.d, body.chemo_stats).run();

          // 365일 초과 정리
          const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
          await env.DB.prepare(
            'DELETE FROM chemo_daily_stats WHERE date < ?'
          ).bind(cutoff).run();
        }
      }
    } catch (statsErr) {
      console.warn('chemo_daily_stats 저장 실패:', statsErr);
    }

    // 통합 일별 AM/PM 통계 배치 저장 (365일 보관)
    let batchWarning = null;
    let batchSaved = 0, batchFailed = 0;
    try {
      if (body.daily_stats_batch) {
        const batch = JSON.parse(body.daily_stats_batch);
        if (Array.isArray(batch) && batch.length > 0) {
          for (const item of batch) {
            if (!item || !item.date || !item.stats) { batchFailed++; continue; }
            try {
              await env.DB.prepare(
                'INSERT OR REPLACE INTO daily_stats (data_type, date, stats, updated_at) VALUES (?, ?, ?, ?)'
              ).bind(type, item.date, JSON.stringify(item.stats), now).run();
              batchSaved++;
            } catch (rowErr) {
              batchFailed++;
              console.warn('daily_stats row 실패:', item.date, rowErr);
            }
          }
          // 사실상 영구 보관 (100년 초과만 정리)
          const cutoff = new Date(Date.now() - 36500 * 86400000).toISOString().slice(0, 10);
          await env.DB.prepare(
            'DELETE FROM daily_stats WHERE data_type = ? AND date < ?'
          ).bind(type, cutoff).run();
        }
      }
    } catch (batchErr) {
      console.warn('daily_stats 배치 저장 실패:', batchErr);
      batchWarning = batchErr.message || String(batchErr);
    }

    return Response.json({
      success: true,
      updated_at: now,
      ...(batchSaved + batchFailed > 0 && { batch: { saved: batchSaved, failed: batchFailed } }),
      ...(batchWarning && { batch_warning: batchWarning })
    });
  } catch (e) {
    return Response.json({ error: '저장 실패: ' + e.message }, { status: 500 });
  }
}
