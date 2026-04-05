// 약품 공급 뉴스 API (공식 데이터만)
// GET /api/news         - 캐시된 데이터 반환 (1시간)
// GET /api/news?debug=1 - 각 API 원본 응답 반환 (디버그)
// POST /api/news        - 수동 새로고침 (관리자)
//
// 데이터 소스:
//   1. 희귀의약품성분  - getRareDrugCpntInq01              (공식 API)
//   2. 필수의약품내역  - getMdcEssntlItemList03             (공식 API)
//   3. 회수/판매중지   - getMdcinRtrvlSleStpgelList03       (공식 API)
//   4. 공급중단        - MdcinPrdctnIncmeSuplyService2      (식약처 실시간)
//   [폴백] 회수 HTML   - nedrug.mfds.go.kr HTML            (API 실패 시)

const CACHE_KEY = 'pharmacy-news';
const CACHE_TTL = 1 * 60 * 60; // 1시간으로 단축 (기존 6시간)

// ── 유틸 ───────────────────────────────────────────────────────
function fmtDate(s) {
  if (!s) return '';
  const d = String(s).replace(/\D/g, '');
  if (d.length === 8) return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
  return String(s).trim();
}

// XML 태그 값 추출 (CDATA 및 일반 텍스트 모두 처리)
function xmlVal(xml, tag) {
  const re = new RegExp(
    '<' + tag + '[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</' + tag + '>|<' + tag + '[^>]*>([^<]*)</' + tag + '>',
    'i'
  );
  const m = xml.match(re);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] || '').trim();
}

// XML <item>...</item> 배열 추출
function xmlItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}

// HTML 태그/엔티티 제거
function extractText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// data.go.kr API 호출 → item 배열 반환
async function callApi(url) {
  const res = await fetch(url, { headers: { 'Accept': '*/*' } });
  const text = await res.text();

  // 서비스 에러 XML 감지
  if (text.includes('OpenAPI_ServiceResponse')) {
    const code = xmlVal(text, 'returnReasonCode') || xmlVal(text, 'errReasonCode');
    const msg  = xmlVal(text, 'returnAuthMsg')    || xmlVal(text, 'errMsg');
    throw new Error('[' + (code||res.status) + '] ' + (msg || 'API오류'));
  }
  if (res.status >= 400) {
    throw new Error('HTTP ' + res.status);
  }

  // JSON 시도
  try {
    const json = JSON.parse(text);
    const body = json?.response?.body || json?.body || json;
    const its  = body?.items?.item || body?.items || [];
    return Array.isArray(its) ? its : (its && typeof its === 'object' ? [its] : []);
  } catch (_) {}

  // XML 파싱
  const code = xmlVal(text, 'resultCode');
  if (code && code !== '00') {
    throw new Error('resultCode=' + code + ' ' + xmlVal(text, 'resultMsg'));
  }
  return xmlItems(text);
}

// XML item 문자열에서 여러 후보 태그 중 첫 번째 값 반환
function getField(itemXml, ...tags) {
  for (const tag of tags) {
    const v = xmlVal(itemXml, tag);
    if (v) return v;
  }
  return '';
}

// ── API 1: 희귀의약품 ──────────────────────────────────────────
async function fetchRareDrug(apiKey) {
  const items = [];
  const url = 'https://apis.data.go.kr/1471000/RareDrugCpntService01/getRareDrugCpntInq01'
    + '?serviceKey=' + apiKey + '&numOfRows=100&pageNo=1';
  const rows = await callApi(url);
  const seen = new Set();

  for (const row of rows) {
    const isXml = typeof row === 'string';
    const g = isXml
      ? (...t) => getField(row, ...t)
      : (k1, ...rest) => [k1, ...rest].reduce((v, k) => v || row[k] || '', '');

    const productName = g('PRDT_NM',  'prdtNm');
    const ingredient  = g('CPNT_KOR_NM', 'cpntKorNm');
    const disease     = g('TRGT_DISS_NM', 'trgtDissNm');
    const company     = g('MFTR_NM',  'mftrNm');
    const designDate  = fmtDate(g('DSGN_YMD', 'dsgnYmd'));
    const cancelDate  = fmtDate(g('DSGN_RTRCN_YMD', 'dsgnRtrcnYmd'));

    if (!productName) continue;
    const key = productName + '|' + (cancelDate || designDate);
    if (seen.has(key)) continue;
    seen.add(key);

    const isCancelled = !!cancelDate;
    const date = cancelDate || designDate;

    items.push({
      title: (isCancelled ? '[희귀약 지정취소] ' : '[희귀의약품 지정] ') + productName,
      summary: [
        disease   ? '대상질환: ' + disease   : '',
        ingredient? '성분: '    + ingredient  : '',
        company   ? '제조사: '  + company     : '',
        designDate? '지정일: '  + designDate  : '',
        isCancelled ? '취소일: ' + cancelDate : '',
      ].filter(Boolean).join('\n'),
      date,
      link: 'https://nedrug.mfds.go.kr',
      source: '식약처 공식',
      category: 'rare_drug',
      categoryLabel: '희귀의약품',
    });
  }
  return items;
}

// ── API 2: 필수의약품 ──────────────────────────────────────────
async function fetchEssentialDrug(apiKey) {
  const items = [];
  const url = 'https://apis.data.go.kr/1471000/MdcEssntlItemInfoService03/getMdcEssntlItemList03'
    + '?serviceKey=' + apiKey + '&numOfRows=100&pageNo=1';
  const rows = await callApi(url);

  for (const row of rows) {
    const isXml = typeof row === 'string';
    const g = isXml
      ? (...t) => getField(row, ...t)
      : (k1, ...rest) => [k1, ...rest].reduce((v, k) => v || row[k] || '', '');

    const name        = g('ESSNTL_ITEM_NAME', 'essntlItemName');
    const efficacy    = g('MED_EFFICACY',     'medEfficacy');
    const appointDate = fmtDate(g('APPOINT_DATE', 'appointDate'));

    if (!name) continue;

    items.push({
      title: '[필수의약품 지정] ' + name,
      summary: [
        efficacy    ? '적응증: '  + efficacy    : '',
        appointDate ? '지정일: '  + appointDate : '',
      ].filter(Boolean).join('\n'),
      date: appointDate,
      link: 'https://nedrug.mfds.go.kr',
      source: '식약처 공식',
      category: 'essential',
      categoryLabel: '필수의약품',
    });
  }
  return items;
}

// ── API 3: 회수/판매중지 (공식 API) ──────────────────────────
async function fetchRecallApi(apiKey) {
  const items = [];
  const url = 'https://apis.data.go.kr/1471000/MdcinRtrvlSleStpgeInfoService04/getMdcinRtrvlSleStpgelList03'
    + '?serviceKey=' + apiKey + '&numOfRows=100&pageNo=1';
  const rows = await callApi(url);

  for (const row of rows) {
    const isXml = typeof row === 'string';
    const g = isXml
      ? (...t) => getField(row, ...t)
      : (k1, ...rest) => [k1, ...rest].reduce((v, k) => v || row[k] || '', '');

    const productName = g('PRDUCT', 'PRDUCT_NM', 'prductNm', 'ITEM_NAME', 'itemName');
    const company     = g('ENTRPS', 'ENTRPS_NM', 'entrpsNm', 'ENTP_NAME', 'entpName');
    const reason      = g('RTRVL_RESN', 'RTRVL_RSN_CN', 'rtrvlRsnCn');
    const grade       = g('RTRVL_GRAD', 'rtrvlGrad');
    const recallDate  = fmtDate(g('RECALL_COMMAND_DATE', 'RTRVL_CMMND_DT', 'RTRVL_ORDR_DE', 'rtrvlOrdrDe'));
    const confDate    = fmtDate(g('CONFN_DE', 'confnDe'));
    if (!productName) continue;

    // 약품명으로 회수 검색 결과 바로 연결 (첫 번째 약품명만 사용)
    const searchName = productName.split(/[,、]/)[0].replace(/^\d+\./, '').trim();
    const link = 'https://nedrug.mfds.go.kr/pbp/CCBAI01?searchOrdr=&itemName='
      + encodeURIComponent(searchName);

    items.push({
      title: '[회수/중지] ' + productName + (company ? ' (' + company + ')' : ''),
      summary: [
        reason    ? '회수사유: ' + reason    : '',
        company   ? '업체: '     + company   : '',
        grade     ? '회수등급: ' + grade + '등급' : '',
        recallDate? '회수명령일: ' + recallDate : '',
        confDate  ? '확인일: '   + confDate   : '',
      ].filter(Boolean).join('\n'),
      date: recallDate || confDate,
      link,
      source: '식약처 공식',
      category: 'recall',
      categoryLabel: '회수/중지',
    });
  }
  return items;
}

// ── API 4: 공급중단 (식약처 실시간 + HIRA 폴백) ─────────────
async function fetchSupplyStop(apiKey) {
  // 1차: 식약처 실시간 API (data.go.kr 15057899)
  try {
    const url = 'https://apis.data.go.kr/1471000/MdcinPrdctnIncmeSuplyService2/getMdcinPrdctnIncmeSuplyList'
      + '?serviceKey=' + apiKey + '&numOfRows=100&pageNo=1';
    const rows = await callApi(url);
    const items = parseSupplyStopMfds(rows);
    if (items.length > 0) return items;
  } catch (e) {
    console.log('공급중단 식약처API 실패(폴백 전환):', e.message);
  }

  // 식약처 API 미활성 시 빈 배열 (승인 후 반영까지 수 시간 소요 가능)
  return [];
}

function parseSupplyStopMfds(rows) {
  const items = [];
  for (const row of rows) {
    const isXml = typeof row === 'string';
    const g = isXml
      ? (...t) => getField(row, ...t)
      : (k1, ...rest) => [k1, ...rest].reduce((v, k) => v || row[k] || '', '');

    const productName    = g('ITEM_NAME',       'itemName');
    const company        = g('ENTP_NAME',       'entpName');
    const suspendDate    = fmtDate(g('SUSPEND_DATE',    'suspendDate'));
    const lastSupplyDate = fmtDate(g('LAST_SUPPLY_DATE','lastSupplyDate'));
    const reason         = g('SUSPEND_REASON',  'suspendReason');
    const ediCode        = g('EDI_CODE',        'ediCode');

    if (!productName) continue;

    items.push({
      title: '[공급중단] ' + productName + (company ? ' (' + company + ')' : ''),
      summary: [
        company        ? '업체: '         + company        : '',
        reason         ? '중단사유: '     + reason         : '',
        suspendDate    ? '중단일: '       + suspendDate    : '',
        lastSupplyDate ? '최종공급일: '   + lastSupplyDate  : '',
        ediCode        ? 'EDI코드: '      + ediCode        : '',
      ].filter(Boolean).join('\n'),
      date: suspendDate || lastSupplyDate,
      link: 'https://nedrug.mfds.go.kr',
      source: '식약처 공식',
      category: 'supply_stop',
      categoryLabel: '공급중단',
    });
  }
  return items;
}


// ── API 5: 약가 변동 감지 (건강보험심사평가원) ────────────────
async function fetchDrugPriceChanges(apiKey, kv) {
  const items = [];

  // 현재 약가 데이터 가져오기 (5페이지 병렬 × 100건 = 500건)
  let currentPrices = {};
  try {
    const pageUrls = Array.from({ length: 5 }, (_, i) =>
      'https://apis.data.go.kr/B551182/dgamtCrtrInfoService1.2/getDgamtList'
      + '?serviceKey=' + apiKey + '&numOfRows=100&pageNo=' + (i + 1)
    );
    const pageResults = await Promise.allSettled(pageUrls.map(url => callApi(url)));

    for (const result of pageResults) {
      if (result.status !== 'fulfilled') continue;
      const rows = result.value;
      for (const row of rows) {
        const isXml = typeof row === 'string';
        const g = isXml
          ? (...t) => getField(row, ...t)
          : (k1, ...rest) => [k1, ...rest].reduce((v, k) => v || row[k] || '', '');

        const code = g('ITEM_SEQ', 'itemSeq', 'MDCN_CD', 'mdcnCd', 'EDI_CD', 'ediCd');
        const name = g('ITEM_NAME', 'itemName', 'MDCN_NM', 'mdcnNm');
        const priceStr = g('MAX_PRICE', 'maxPrice', 'UPLMT_AMT', 'uplmtAmt', 'AMT', 'amt');
        const price = parseFloat(String(priceStr).replace(/,/g, '')) || 0;
        const spec = g('ITEM_SPEC', 'itemSpec', 'MDCN_SPCFC', 'mdcnSpcfc');
        const company = g('ENTP_NAME', 'entpName', 'MFTR_NM', 'mftrNm');

        if (!code || !name || !price) continue;
        currentPrices[code] = { n: name.substring(0, 60), p: price, s: spec, c: company };
      }
    }
  } catch (e) {
    console.warn('약가API 실패:', e.message);
    return [];
  }

  const count = Object.keys(currentPrices).length;
  if (count === 0) return [];
  console.log('[약가] 현재 약가 ' + count + '건 조회');

  // 이전 약가 데이터 로드 (KV 캐시)
  let prevPrices = {};
  try {
    const stored = await kv.get('drug-prices', { type: 'json' });
    if (stored) prevPrices = stored;
  } catch (e) { /* 최초 실행 시 없음 */ }

  // 비교: 가격 변동 감지
  const prevCount = Object.keys(prevPrices).length;
  if (prevCount > 0) {
    for (const [code, curr] of Object.entries(currentPrices)) {
      const prev = prevPrices[code];
      if (!prev || prev.p === curr.p) continue;

      const diff = curr.p - prev.p;
      const pct = ((diff / prev.p) * 100).toFixed(1);
      const isUp = diff > 0;

      items.push({
        title: (isUp ? '[약가인상] ' : '[약가인하] ') + curr.n,
        summary: [
          curr.c ? '업체: ' + curr.c : '',
          curr.s ? '규격: ' + curr.s : '',
          '변경전: ' + prev.p.toLocaleString() + '원',
          '변경후: ' + curr.p.toLocaleString() + '원',
          '변동: ' + (isUp ? '+' : '') + diff.toLocaleString() + '원 (' + (isUp ? '+' : '') + pct + '%)',
        ].filter(Boolean).join('\n'),
        date: new Date().toISOString().slice(0, 10),
        link: 'https://www.hira.or.kr',
        source: '심평원 약가',
        category: 'price_change',
        categoryLabel: isUp ? '약가인상' : '약가인하',
      });
    }
    console.log('[약가] 변동 감지: ' + items.length + '건');
  } else {
    console.log('[약가] 최초 실행 - 기준 데이터 저장');
  }

  // 현재 약가 저장 (다음 비교용, 30일 TTL)
  await kv.put('drug-prices', JSON.stringify(currentPrices), { expirationTtl: 30 * 86400 });

  return items;
}

// ── 폴백: 식약처 HTML 회수/판매중지 ──────────────────────────
async function fetchRecallHtml() {
  const items = [];
  try {
    const res = await fetch('https://nedrug.mfds.go.kr/pbp/CCBAI01', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();

    const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbodyMatch) return items;
    const tbody = tbodyMatch[1];

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRegex.exec(tbody)) !== null) {
      const row = rm[1];
      const tds = [];
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let tm;
      while ((tm = tdRegex.exec(row)) !== null) tds.push(extractText(tm[1]));
      if (tds.length < 5) continue;

      // 컬럼: 순번, 제품명, 업체명, 회수사유, 제조번호, 회수명령일자, ...
      const productName = tds[1] || '';
      const company     = tds[2] || '';
      const reason      = tds[3] || '';
      const recallDate  = tds[5] || '';

      const linkMatch = row.match(/getItemDetail\?itemSeq=(\d+)/);
      const link = linkMatch
        ? 'https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=' + linkMatch[1]
        : 'https://nedrug.mfds.go.kr/pbp/CCBAI01';

      if (!productName || productName.length < 2) continue;

      items.push({
        title: '[회수/중지] ' + productName + (company ? ' (' + company + ')' : ''),
        summary: [
          reason     ? '회수사유: ' + reason     : '',
          company    ? '업체: '     + company     : '',
          recallDate ? '회수명령일: ' + recallDate : '',
        ].filter(Boolean).join('\n'),
        date: recallDate,
        link,
        source: '식약처 공식',
        category: 'recall',
        categoryLabel: '회수/중지',
      });
    }
  } catch (e) {
    console.error('회수HTML 실패:', e.message);
  }
  return items.slice(0, 30);
}

// ── 메인 크롤 ─────────────────────────────────────────────────
async function crawlNews(apiKey, kv) {
  const allItems = [];
  const seenTitles = new Set();
  const errors = [];

  const tasks = [
    { name: '희귀의약품', fn: () => fetchRareDrug(apiKey) },
    { name: '필수의약품', fn: () => fetchEssentialDrug(apiKey) },
    { name: '회수/중지(API)', fn: () => fetchRecallApi(apiKey) },
    { name: '공급중단',   fn: () => fetchSupplyStop(apiKey) },
    { name: '회수/중지(HTML)', fn: () => fetchRecallHtml() },
    { name: '약가변동',   fn: () => kv ? fetchDrugPriceChanges(apiKey, kv) : Promise.resolve([]) },
  ];

  const results = await Promise.allSettled(tasks.map(t => t.fn()));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (!seenTitles.has(item.title)) {
          seenTitles.add(item.title);
          allItems.push(item);
        }
      }
    } else {
      errors.push(tasks[i].name + ': ' + r.reason?.message);
    }
  });

  // 날짜 내림차순
  allItems.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return {
    items: allItems.slice(0, 200),
    crawledAt: new Date().toISOString(),
    errors: errors.length ? errors : undefined,
    counts: {
      recall:       allItems.filter(x => x.category === 'recall').length,
      supply_stop:  allItems.filter(x => x.category === 'supply_stop').length,
      rare_drug:    allItems.filter(x => x.category === 'rare_drug').length,
      essential:    allItems.filter(x => x.category === 'essential').length,
      price_change: allItems.filter(x => x.category === 'price_change').length,
    },
  };
}

// ── Cloudflare Handlers ────────────────────────────────────────
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  // 디버그: 각 API 원본 응답 확인
  if (url.searchParams.get('debug') === '1') {
    const apiKey = env.DATA_GO_KR_API_KEY || '';
    if (!apiKey) return Response.json({ error: 'API 키 미설정' });
    const endpoints = [
      { name: '희귀의약품', url: 'https://apis.data.go.kr/1471000/RareDrugCpntService01/getRareDrugCpntInq01?serviceKey=' + apiKey + '&numOfRows=2&pageNo=1' },
      { name: '필수의약품', url: 'https://apis.data.go.kr/1471000/MdcEssntlItemInfoService03/getMdcEssntlItemList03?serviceKey=' + apiKey + '&numOfRows=2&pageNo=1' },
      { name: '회수/판매중지(API)', url: 'https://apis.data.go.kr/1471000/MdcinRtrvlSleStpgeInfoService04/getMdcinRtrvlSleStpgelList03?serviceKey=' + apiKey + '&numOfRows=2&pageNo=1' },
      { name: '공급중단(식약처)', url: 'https://apis.data.go.kr/1471000/MdcinPrdctnIncmeSuplyService2/getMdcinPrdctnIncmeSuplyList?serviceKey=' + apiKey + '&numOfRows=2&pageNo=1' },
      { name: '약가기준(HIRA)', url: 'https://apis.data.go.kr/B551182/dgamtCrtrInfoService1.2/getDgamtList?serviceKey=' + apiKey + '&numOfRows=2&pageNo=1' },
      { name: '회수(HTML)', url: 'https://nedrug.mfds.go.kr/pbp/CCBAI01' },
    ];
    const results = {};
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep.url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } });
        const text = await res.text();
        results[ep.name] = { status: res.status, body: text.substring(0, 300) };
      } catch (e) {
        results[ep.name] = { error: e.message };
      }
    }
    return Response.json({ debug: true, apiKey: apiKey.substring(0,8)+'...', results });
  }

  try {
    const cached = await env.NEWS_CACHE.get(CACHE_KEY, { type: 'json' });
    if (cached) {
      const age = (Date.now() - new Date(cached.crawledAt).getTime()) / 1000;
      if (age < CACHE_TTL) {
        // Cache-Control 헤더 추가로 브라우저 캐싱 방지
        return Response.json({ ...cached, fromCache: true }, {
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
      }
    }
    const apiKey = env.DATA_GO_KR_API_KEY || '';
    if (!apiKey) return Response.json({ items: [], error: 'API 키 미설정', fromCache: false });
    const news = await crawlNews(apiKey, env.NEWS_CACHE);
    await env.NEWS_CACHE.put(CACHE_KEY, JSON.stringify(news), { expirationTtl: CACHE_TTL });
    return Response.json({ ...news, fromCache: false }, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  } catch (e) {
    const cached = await env.NEWS_CACHE.get(CACHE_KEY, { type: 'json' });
    if (cached) return Response.json({ ...cached, fromCache: true, error: e.message });
    return Response.json({ items: [], error: e.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  try {
    const apiKey = env.DATA_GO_KR_API_KEY || '';
    if (!apiKey) return Response.json({ error: 'API 키 미설정' }, { status: 500 });
    const news = await crawlNews(apiKey, env.NEWS_CACHE);
    await env.NEWS_CACHE.put(CACHE_KEY, JSON.stringify(news), { expirationTtl: CACHE_TTL });
    return Response.json({ ...news, fromCache: false, refreshed: true });
  } catch (e) {
    const cached = await env.NEWS_CACHE.get(CACHE_KEY, { type: 'json' });
    if (cached) return Response.json({ ...cached, fromCache: true, error: e.message });
    return Response.json({ items: [], error: e.message }, { status: 500 });
  }
}
