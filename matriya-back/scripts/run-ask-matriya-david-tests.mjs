/**
 * David’s three Ask Matriya checks — prints raw HTTP body (JSON) per case.
 *
 * Requires: running matriya-back + valid JWT (user must exist in DB).
 *
 *   set MATRIYA_TEST_API_URL=http://127.0.0.1:8000
 *   set MATRIYA_TEST_JWT=<Bearer token without "Bearer " prefix>
 *   npm run test:ask-matriya-david
 *
 * For PARTIAL case (2) with ratio matrix, set on the server:
 *   MATRIYA_GAP_EXPECTED_RATIOS=3:1:1,2.5:1:1.5,3.5:1:0.5
 *
 * Deterministic sign-off (same JSON as npm run verify:david-three):
 *   MATRIYA_DAVID_ACCEPTANCE_FIXTURES=1
 */
const base = (process.env.MATRIYA_TEST_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const token = (process.env.MATRIYA_TEST_JWT || '').trim();

const cases = [
  {
    name: '1_NO_EVIDENCE',
    message: 'איך לשפר את הפורמולציה הזו?'
  },
  {
    name: '2_PARTIAL_APP_PER_MEL',
    message: 'מה היחס בין APP, PER, MEL?'
  },
  {
    name: '3_VALID_EXPANSION_RATIO',
    message: 'מאיזה מסמך נלקח Expansion Ratio = 18.5?'
  }
];

async function run() {
  if (!token) {
    console.error(JSON.stringify({
      _script_error: 'Set MATRIYA_TEST_JWT to a valid access token (same string you send after Bearer )'
    }));
    process.exit(2);
  }

  for (const c of cases) {
    const url = `${base}/ask-matriya`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message: c.message })
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _parse_error: true, raw: text };
    }
    const out = {
      case: c.name,
      httpStatus: res.status,
      request: { url, message: c.message },
      response: parsed
    };
    console.log(JSON.stringify(out, null, 2));
    console.log('');
  }
}

run().catch((e) => {
  console.error(JSON.stringify({ _script_error: String(e.message || e) }));
  process.exit(1);
});
