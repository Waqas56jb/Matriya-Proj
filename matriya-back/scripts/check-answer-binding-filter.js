import assert from 'assert';
import {
  filterSnippetsByAnswerBinding,
  getAnswerBindingRequirements
} from '../lib/answerSourceBindingFilter.js';

const reply = 'Expansion Ratio = 18.5 בניסוי INT-TFX-001 לפי הדוח.';
const reqs = getAnswerBindingRequirements(reply);
assert.ok(reqs && reqs.length >= 2, 'should extract decimals and INT id');

const snips = [
  { filename: 'other.pdf', text: 'הערה כללית 3.0 ולא קשור' },
  { filename: 'ניסוי_INT-TFX_001.pdf', text: 'טבלה: Expansion Ratio = 18.5 במדגם' }
];
const out = filterSnippetsByAnswerBinding(snips, reply);
assert.strictEqual(out.length, 1);
assert.ok(out[0].text.includes('18.5'));

const empty = filterSnippetsByAnswerBinding(snips, 'תשובה כללית ללא מספרים.');
assert.strictEqual(empty.length, 2);

const heReply = 'לפי המסמך, יחס התרחבות 18.5 בניסוי.';
const heSnips = [
  { filename: 'a.pdf', text: 'טקסט כללי ללא מספר' },
  { filename: 'ניסוי_INT-TFX.pdf', text: 'יחס התרחבות 18.5 בטבלה' }
];
const heOut = filterSnippetsByAnswerBinding(heSnips, heReply);
assert.strictEqual(heOut.length, 1);

console.log('check-answer-binding-filter: OK');
