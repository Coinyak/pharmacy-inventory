// API 미들웨어: CORS + 데이터 타입 추출
// 비밀번호 인증 없이 type만 확인

export async function onRequest(context) {
  const { request, env, next } = context;

  // CORS 헤더
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
  };

  // OPTIONS (preflight)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // PUT 요청: Authorization 헤더에서 타입만 추출 (인증 없음)
  if (request.method === 'PUT' || request.method === 'DELETE') {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: '인증 필요' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = auth.slice(7).trim();
    // 토큰이 'chemo' 또는 'general' 직접 전달
    const type = ['chemo', 'general'].includes(token) ? token : token.split(':')[0];
    if (!['chemo', 'general'].includes(type)) {
      return new Response(JSON.stringify({ error: '잘못된 타입' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    context.data = { adminType: type };
  }

  // 다음 핸들러 실행
  const response = await next();

  // CORS 헤더 추가
  const newResponse = new Response(response.body, response);
  for (const [k, v] of Object.entries(corsHeaders)) {
    newResponse.headers.set(k, v);
  }
  return newResponse;
}
