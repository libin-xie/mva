// Markdown report renderer. Pure module: no VS Code dependency.
import { ProgramModel, TreeNode, Flag, buildCallTree, routineGosubs, makeExcluder, findLabel } from './parser.js';

export type DiagramStyle = 'mermaid' | 'markmap' | 'both' | 'none';

export interface RenderOptions {
  sourcePath: string;
  generatedAt: Date;
  diagram: DiagramStyle;
  maxDepth: number;
  version: string;
  notes?: string;
  /** Routine names (or * ? patterns) to leave out of the call tree and routine table. */
  exclude?: string[];
  /** Returns true when a report for the named program already exists, so it can be linked. */
  reportExists?: (programName: string) => boolean;
}

const NOTES_START = '<!-- mvba:notes:start — anything you write between these two markers is kept when the report is regenerated -->';
const NOTES_END = '<!-- mvba:notes:end -->';

export function extractNotes(existing: string): string | undefined {
  const m = /<!-- mvba:notes:start[^>]*-->\r?\n?([\s\S]*?)\r?\n?<!-- mvba:notes:end -->/.exec(existing);
  return m ? m[1] : undefined;
}

export function reportFileName(programName: string): string {
  let n = programName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!n) n = 'UNTITLED';
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(n)) n = '_' + n;
  return n + '.md';
}

const TYPE_LABEL: Record<ProgramModel['type'], string> = {
  PROGRAM: 'Main program',
  MAIN: 'Main program',
  SUBROUTINE: 'Subroutine',
  FUNCTION: 'Function',
};

function cell(s: string): string { return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
function md(s: string): string { return s.replace(/([\\`*_[\]<>|])/g, '\\$1'); }
function lineList(lines: number[]): string { return lines.length ? lines.join(', ') : '—'; }

function pad2(n: number) { return String(n).padStart(2, '0'); }
function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Call tree renderers

const FLAG_TEXT: Record<Flag, string> = {
  unreachable: '⚠ unreachable',
  recursive: '↺ recursive',
  seeAbove: '(see above)',
  notFound: '⚠ label not found',
  onGosub: '(ON … GOSUB)',
  depthLimit: '… deeper calls hidden',
};

function rootTitle(model: ProgramModel): string {
  const kind = model.type === 'SUBROUTINE' ? 'subroutine' : model.type === 'FUNCTION' ? 'function' : 'main program';
  return `${model.name} (${kind})`;
}

export function renderTextTree(model: ProgramModel, tree: TreeNode): string {
  const rows: { left: string; info: string }[] = [];
  const walk = (nodes: TreeNode[], prefix: string) => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      const left = prefix + (last ? '└── ' : '├── ') + n.name;
      const def = n.defLine !== undefined ? `line ${n.defLine}` : 'line ?';
      const flags = n.flags.map(f => FLAG_TEXT[f]).join('  ');
      rows.push({ left, info: `${def.padEnd(9)}· called line ${n.calledLine}${flags ? '   ' + flags : ''}` });
      walk(n.children, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(tree.children, '');
  const width = Math.max(0, ...rows.map(r => r.left.length)) + 2;
  const body = rows.map(r => r.left.padEnd(width) + r.info);
  if (!rows.length) body.push('(no internal GOSUB calls)');
  return [rootTitle(model), ...body].join('\n');
}

function mermaidText(s: string): string { return s.replace(/"/g, '#quot;'); }

export function renderMermaid(model: ProgramModel, tree: TreeNode): string {
  const out = ['flowchart TD', `  n0["${mermaidText(rootTitle(model).replace(' program)', ')'))}"]`];
  const warn: string[] = [];
  let id = 0;
  const walk = (parent: string, nodes: TreeNode[]) => {
    for (const n of nodes) {
      const me = `n${++id}`;
      let label = n.defLine !== undefined ? `${n.name} · L${n.defLine}` : n.name;
      if (n.flags.includes('notFound')) label += ' ⚠ not found';
      if (n.flags.includes('recursive')) label += ' ↺';
      if (n.flags.includes('seeAbove')) label += ' (see above)';
      if (n.flags.includes('depthLimit')) label += ' …';
      if (n.flags.includes('unreachable')) label += ' ⚠';
      const arrow = n.flags.includes('unreachable') ? '-.->' : '-->';
      const edgeLabel = n.flags.includes('onGosub') ? '|ON|' : '';
      out.push(`  ${parent} ${arrow}${edgeLabel} ${me}["${mermaidText(label)}"]`);
      if (n.flags.some(f => f === 'unreachable' || f === 'notFound' || f === 'recursive')) warn.push(me);
      walk(me, n.children);
    }
  };
  walk('n0', tree.children);
  if (warn.length) {
    out.push('  classDef warn stroke:#c2410c,stroke-width:2px,stroke-dasharray:5 3;');
    out.push(`  class ${warn.join(',')} warn;`);
  }
  return out.join('\n');
}

export function renderMarkmap(model: ProgramModel, tree: TreeNode): string {
  const out = [`# ${md(rootTitle(model))}`];
  const walk = (nodes: TreeNode[], indent: string) => {
    for (const n of nodes) {
      let text = n.defLine !== undefined ? `${md(n.name)} · L${n.defLine}` : md(n.name);
      const flags = n.flags.map(f => FLAG_TEXT[f]);
      if (flags.length) text += ' ' + flags.join(' ');
      out.push(`${indent}- ${text}`);
      walk(n.children, indent + '  ');
    }
  };
  walk(tree.children, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Full report

export function renderReport(model: ProgramModel, opts: RenderOptions): string {
  const isExcluded = makeExcluder(opts.exclude);
  const tree = buildCallTree(model, opts.maxDepth, isExcluded);
  // How often each excluded routine is called, for the note under the call tree.
  const hidden = new Map<string, number>();
  for (const g of model.segments.flatMap(s => s.gosubs)) {
    const name = findLabel(model.labelIndex, g.target)?.label ?? g.target;
    if (isExcluded(name)) hidden.set(name, (hidden.get(name) ?? 0) + 1);
  }
  const L: string[] = [];
  const push = (...xs: string[]) => L.push(...xs);
  const exists = opts.reportExists ?? (() => false);

  push(`<!-- Generated by MultiValue Basic Analyser ${opts.version}. Re-run "Analyse Program" to refresh; only the Notes section is kept. -->`);
  push(`# ${md(model.name)}`, '');
  push(`> **${TYPE_LABEL[model.type]}** · \`${opts.sourcePath}\` · ${model.metrics.totalLines} lines · analysed ${stamp(opts.generatedAt)}`, '');

  // Summary
  push('## Summary', '');
  if (model.summaryLines.length) push(...model.summaryLines.map(l => md(l) + '  '), '');
  else push('TODO – no header comment was found at the top of the program. Describe what it does here, or add a comment block to the source.', '');

  // Signature
  push('## Signature', '');
  if (model.type === 'SUBROUTINE' || model.type === 'FUNCTION') {
    push(`\`${model.type} ${model.name}(${model.params.map(p => (p.isMatrix ? 'MAT ' : '') + p.name).join(', ')})\``, '');
    if (model.params.length) {
      push('| # | Parameter | Direction (guessed) | Description |', '|---|---|---|---|');
      model.params.forEach((p, i) => push(`| ${i + 1} | ${cell((p.isMatrix ? 'MAT ' : '') + p.name)} | ${p.direction} | TODO |`));
      push('');
      push('_Direction is a guess: "out" or "in/out" means the routine assigns a value to the parameter._', '');
    } else push('No parameters.', '');
    if (model.type === 'FUNCTION') push(`**Returns:** ${model.returns ? '`' + model.returns + '`' : 'TODO'}`, '');
  } else {
    push(`${model.type === 'PROGRAM' ? '`PROGRAM ' + model.name + '` – ' : ''}main program, takes no parameters.`, '');
  }

  // Metrics
  const m = model.metrics;
  push('## Metrics', '');
  push('| Lines | Code | Comments | Blank | Labels | GOSUBs | GOTOs | Max nesting |', '|---|---|---|---|---|---|---|---|');
  push(`| ${m.totalLines} | ${m.codeLines} | ${m.commentLines} | ${m.blankLines} | ${m.labels} | ${m.gosubs} | ${m.gotos} | ${m.maxNesting} |`, '');

  // Call tree
  push('## Internal call tree', '');
  push('Calls are shown in the order they run, from the main body down. Each entry gives the line where the label is defined and the line of the GOSUB that calls it.', '');
  if (hidden.size) {
    const list = [...hidden].map(([n, c]) => `${md(n)} (${c} call${c === 1 ? '' : 's'})`).join(', ');
    push(`_Hidden by the Exclude Routines setting: ${list}. Routines called only through these are hidden too._`, '');
  }
  push('```text', renderTextTree(model, tree), '```', '');
  if (tree.children.length && (opts.diagram === 'mermaid' || opts.diagram === 'both')) {
    push('```mermaid', renderMermaid(model, tree), '```', '');
  }
  if (tree.children.length && (opts.diagram === 'markmap' || opts.diagram === 'both')) {
    push('```markmap', renderMarkmap(model, tree), '```', '');
  }

  // External calls
  push('## External calls', '');
  if (model.externals.length) {
    for (const e of model.externals) {
      const link = e.kind === 'CALL' && !e.dynamic && exists(e.name) ? ` → [${md(e.name)}](${encodeURI(reportFileName(e.name))})` : '';
      const dyn = e.dynamic ? ' _(dynamic – resolved at run time)_' : '';
      const nameText = e.kind === 'EXECUTE' || e.kind === 'PERFORM' ? '`' + e.name.replace(/`/g, "'") + '`' : md(e.name);
      push(`- ${e.kind} ${nameText} (line${e.lines.length > 1 ? 's' : ''} ${e.lines.join(', ')})${dyn}${link}`);
    }
    push('');
  } else push('None.', '');

  // Warnings
  push('## Warnings', '');
  if (model.warnings.length) {
    for (const w of model.warnings) push(`- ${w.line !== undefined ? `Line ${w.line}: ` : ''}${md(w.message)}`);
    push('');
  } else push('None found.', '');

  // Files
  push('## Files', '');
  if (model.files.length) {
    push('| File | Variable | Operations | Lines |', '|---|---|---|---|');
    for (const f of model.files) push(`| ${cell(f.fileName)} | ${cell(f.variable)} | ${f.ops.join(', ')} | ${lineList(f.lines)} |`);
    push('');
  } else push('No files opened or read.', '');

  // Includes / common / equates
  push('## Includes, common and equates', '');
  if (!model.includes.length && !model.commons.length && !model.equates.length) push('None.', '');
  else {
    for (const i of model.includes) push(`- ${md(i.text)} (line ${i.line})`);
    for (const c of model.commons) push(`- COMMON ${md(c.name)} (line ${c.line})`);
    if (model.equates.length) {
      const shown = model.equates.slice(0, 25).map(e => md(e.name)).join(', ');
      const more = model.equates.length > 25 ? `, and ${model.equates.length - 25} more` : '';
      push(`- ${model.equates.length} EQUATE${model.equates.length === 1 ? '' : 's'}: ${shown}${more}`);
    }
    push('');
  }

  // Internal routines
  push('## Internal routines', '');
  // Routines = GOSUB targets, plus labels nothing reaches (dead code). GOTO-only labels are part of a routine.
  const routines = model.segments.filter(s => s.label !== null && model.labelIndex.get(s.label) === s && !isExcluded(s.label) &&
    (model.gosubTargets.has(s.label) || !model.gotoTargets.has(s.label)) &&
    (model.gosubTargets.has(s.label) || model.warnings.some(w => w.line === s.line && /never called/.test(w.message))));
  if (routines.length) {
    push('| Label | Line | Lines | Called from (GOSUB) | Calls | Purpose |', '|---|---|---|---|---|---|');
    for (const r of routines) {
      const calledFrom = model.segments.flatMap(s => s.gosubs).filter(g => g.target === r.label).map(g => g.line);
      const gotoFrom = model.segments.flatMap(s => s.gotos).filter(g => g.target === r.label).map(g => g.line);
      let from = lineList([...new Set(calledFrom)]);
      if (!calledFrom.length && gotoFrom.length) from = `GOTO ${gotoFrom.join(', ')}`;
      const calls = [...new Set(routineGosubs(model, r).map(g => g.target))].filter(n => !isExcluded(n));
      const span = r.endLine - r.line + 1;
      push(`| ${cell(r.label!)} | ${r.line} | ${span} | ${from} | ${cell(calls.join(', ') || '—')} | TODO |`);
    }
    push('');
  } else push('No internal labels.', '');

  // Notes
  push('## Notes', '', NOTES_START, opts.notes ?? '', NOTES_END, '');
  return L.join('\n');
}

