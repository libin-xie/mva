// Plain-Node tests for the parser and report (no VS Code needed).
// Run: node test/run-tests.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseProgram, buildCallTree } = require('../out/parser.js');
const { renderReport, renderTextTree, extractNotes, reportFileName } = require('../out/report.js');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name); console.log(e.message); process.exitCode = 1; }
};

/** Flatten a tree into "depth name def called flags" strings for easy comparison. */
const flat = (tree) => {
  const out = [];
  const walk = (nodes, d) => nodes.forEach(n => {
    out.push(`${d} ${n.name} ${n.defLine ?? '?'} ${n.calledLine}${n.flags.length ? ' ' + n.flags.join(',') : ''}`);
    walk(n.children, d + 1);
  });
  walk(tree.children, 1);
  return out;
};

console.log('TEST1 (expected output from the requirements doc)');
const t1 = parseProgram(fixture('TEST1'), 'TEST1');
test('header', () => { assert.equal(t1.name, 'TEST1'); assert.equal(t1.type, 'PROGRAM'); });
test('call tree matches the doc exactly (label line · called line)', () => {
  assert.deepEqual(flat(buildCallTree(t1)), [
    '1 SUB1 6 2',
    '2 SUB11 12 7',
    '3 SUB111 20 15',
    '2 SUB12 28 8',
    '1 SUB2 57 3',
    '2 SUB22 64 60',
    '3 SUB222 78 67',
    '2 SUB23 72 61',
    '1 SUB3 35 4',
    '2 SUB31 41 36',
    '2 SUB32 49 37',
  ]);
});
test('no warnings', () => assert.deepEqual(t1.warnings, []));
test('CRLF line endings give the same tree', () => {
  const crlf = parseProgram(fixture('TEST1').replace(/\n/g, '\r\n'), 'TEST1');
  assert.deepEqual(flat(buildCallTree(crlf)), flat(buildCallTree(t1)));
});
test('metrics', () => {
  assert.equal(t1.metrics.totalLines, 85);
  assert.equal(t1.metrics.labels, 11);
  assert.equal(t1.metrics.gosubs, 11);
});

console.log('GET.CUST (edge cases)');
const g = parseProgram(fixture('GET.CUST'), 'GET.CUST');
test('subroutine header split over two lines', () => {
  assert.equal(g.type, 'SUBROUTINE');
  assert.equal(g.name, 'GET.CUST');
  assert.deepEqual(g.params.map(p => `${p.name}:${p.direction}`), ['CUST.ID:in', 'REC:in/out', 'ERR:out']);
});
test('summary from header comment, separator lines skipped', () => {
  assert.deepEqual(g.summaryLines, ['GET.CUST - read a customer and check credit status', 'Called from order entry screens.']);
});
test('call tree: ON GOSUB, recursion, unreachable, missing label, string/comment GOSUBs ignored', () => {
  assert.deepEqual(flat(buildCallTree(g)), [
    '1 LOG.IT 72 18',
    '1 CHECK.A 55 22 onGosub',
    '2 WRITE.AUDIT 60 56',
    '1 CHECK.B 57 22 onGosub',
    '1 VALIDATE 45 23',
    '2 CHECK.CREDIT 51 47',
    '3 VALIDATE 45 52 recursive',
    '2 NEVER.RUNS 65 49 unreachable',
    '1 NO.SUCH.LABEL ? 24 notFound',
    '1 WRITE.AUDIT 60 30',
  ]);
});
test('warnings', () => {
  const w = g.warnings.map(x => `${x.line}: ${x.message}`);
  const expectStarts = [
    '17: READU has no LOCKED clause',
    '24: GOSUB NO.SUCH.LABEL: label not found',
    '40: CALL @DYN.ROUTINE is a dynamic call',
    '49: Line 49 in routine VALIDATE can never run: RETURN on line 48',
    '57: Routine CHECK.A has no RETURN/STOP before label CHECK.B',
    '68: Label ORPHAN is never called',
    '74: Duplicate label LOG.IT (first defined on line 72)',
  ];
  assert.equal(w.length, expectStarts.length, 'warning count:\n' + w.join('\n'));
  expectStarts.forEach((s, i) => assert.ok(w[i].startsWith(s), `expected "${s}…" got "${w[i]}"`));
});
test('files, includes, common, equates, externals', () => {
  assert.deepEqual(g.files.map(f => `${f.fileName}|${f.variable}|${f.ops.join(',')}|${f.lines.join(',')}`), [
    'CUSTOMER|F.CUST|OPEN,READU,WRITE,DELETE|11,17,42,62',
    'DICT CUSTOMER|D.CUST|OPEN|15',
    'AUDIT.LOG|F.AUDIT|OPEN,WRITE|16,61',
  ]);
  assert.deepEqual(g.includes.map(i => i.text), ['$INCLUDE BP COMMON.EQUATES']);
  assert.deepEqual(g.commons.map(c => c.name), ['/GLOBALS/']);
  assert.deepEqual(g.equates.map(e => e.name), ['AM', 'VM', 'MAX.TRIES']);
  assert.deepEqual(g.externals.map(e => `${e.kind} ${e.name}${e.dynamic ? ' (dyn)' : ''}`), [
    'CALL LOG.ERROR', 'CALL @DYN.ROUTINE (dyn)', 'EXECUTE "SELECT CUSTOMER WITH STATUS = \'A\'"',
  ]);
});
test('GOTO loop on numeric label keeps the main body together', () => {
  assert.ok(g.labelIndex.has('10'));
  assert.ok(!g.warnings.some(w => /Label 10\b/.test(w.message)));
});

console.log('Report');
const opts = { sourcePath: 'BP/TEST1', generatedAt: new Date(2026, 9, 30, 14, 5), diagram: 'both', maxDepth: 10, version: '0.1.0' };
const report = renderReport(t1, opts);
test('has every section in order', () => {
  const heads = report.split('\n').filter(l => l.startsWith('## '));
  assert.deepEqual(heads, ['## Summary', '## Signature', '## Metrics', '## Internal call tree', '## External calls', '## Warnings',
    '## Files', '## Includes, common and equates', '## Internal routines', '## Notes']);
});
test('contains mermaid and markmap blocks', () => {
  assert.ok(report.includes('```mermaid\nflowchart TD'));
  assert.ok(report.includes('```markmap\n# TEST1 (main program)'));
});
test('notes survive regeneration', () => {
  const edited = report.replace(/(<!-- mvba:notes:start[^>]*-->\n)/, '$1Checked by Jon – SUB2 needs a rewrite.\nSecond line.');
  const notes = extractNotes(edited);
  assert.equal(notes, 'Checked by Jon – SUB2 needs a rewrite.\nSecond line.');
  const again = renderReport(t1, { ...opts, notes });
  assert.equal(extractNotes(again), notes);
});
test('depth limit hides deeper calls', () => {
  const lim = renderTextTree(t1, buildCallTree(t1, 1));
  assert.ok(lim.includes('… deeper calls hidden'));
  assert.ok(!lim.includes('SUB111'));
});
test('safe file names', () => {
  assert.equal(reportFileName('GET.CUST'), 'GET.CUST.md');
  assert.equal(reportFileName('A/B:C'), 'A_B_C.md');
  assert.equal(reportFileName('CON'), '_CON.md');
});

console.log('Exclude Routines setting');
const ORDERS = ['PROGRAM ORDERS', 'GOSUB OPENFILES', 'GOSUB PROCESS', 'STOP', 'OPENFILES:', 'GOSUB ERR.HANDLE', 'RETURN',
  'PROCESS:', 'GOSUB ERR.HANDLE', 'GOSUB CALC', 'GOSUB ERR.LOG', 'RETURN', 'CALC:', 'GOSUB OPENFILES', 'RETURN',
  'ERR.HANDLE:', 'GOSUB ERR.LOG', 'RETURN', 'ERR.LOG:', 'RETURN', 'END'].join('\n');
const om = parseProgram(ORDERS, 'ORDERS');
const { makeExcluder } = require('../out/parser.js');
test('matcher: exact names ignore case, * and ? wildcards', () => {
  const x = makeExcluder(['openfiles', 'ERR.*', 'SUB?', ' ', '']);
  assert.ok(x('OPENFILES') && x('ERR.HANDLE') && x('err.log') && x('SUB1'));
  assert.ok(!x('OPENFILES2') && !x('ERRHANDLE') && !x('SUB11') && !x('PROCESS'));
  assert.ok(!makeExcluder([])('ANY') && !makeExcluder(undefined)('ANY'));
});
test('excluded routines vanish from the tree, wherever they are called', () => {
  assert.deepEqual(flat(buildCallTree(om, 10, makeExcluder(['OPENFILES', 'ERR.*']))), ['1 PROCESS 8 3', '2 CALC 13 10']);
});
test('a hidden routine hides its subtree (TEST1 without SUB2)', () => {
  const f = flat(buildCallTree(t1, 10, makeExcluder(['SUB2'])));
  assert.ok(!f.some(l => /SUB2/.test(l)), f.join('\n'));
  assert.equal(f.length, 7);
});
test('report: note lists hidden routines with call counts; table and diagrams skip them', () => {
  const r = renderReport(om, { ...opts, exclude: ['OPENFILES', 'ERR.*'] });
  assert.match(r, /Hidden by the Exclude Routines setting: OPENFILES \(2 calls\), ERR\.HANDLE \(2 calls\), ERR\.LOG \(2 calls\)/);
  const table = r.split('## Internal routines')[1].split('## Notes')[0];
  assert.match(table, /\| PROCESS \| 8 \|.*\| CALC \|/);
  assert.match(table, /\| CALC \| 13 \|.*\| — \|/);
  assert.ok(!/OPENFILES|ERR\./.test(table), table);
  const mermaid = /```mermaid\n([\s\S]*?)```/.exec(r)[1];
  assert.ok(!/OPENFILES|ERR\./.test(mermaid));
  assert.ok(!/OPENFILES|ERR\./.test(/```markmap\n([\s\S]*?)```/.exec(r)[1]));
});
test('no exclusions → no note, everything shown', () => {
  const r = renderReport(om, opts);
  assert.ok(!r.includes('Hidden by'));
  assert.ok(r.includes('ERR.LOG'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
