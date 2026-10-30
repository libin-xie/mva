// UniVerse BASIC static analyser.
// Pure module: no VS Code dependency, so it can be unit-tested with plain Node.

export interface Stmt {
  line: number;   // 1-based line where the statement starts
  raw: string;    // statement text as written
  code: string;   // same text with string-literal contents blanked out
}

interface LineInfo {
  no: number;
  raw: string;
  label?: string;
  stmts: Stmt[];
  isCommentLine: boolean;
  isBlank: boolean;
  isContinuation: boolean;
}

export interface CallRef {
  target: string;
  line: number;
  reachable: boolean;
  viaOn: boolean;
}

export interface Segment {
  label: string | null;      // null = main body
  line: number;              // label line (or 1 for main)
  endLine: number;
  gosubs: CallRef[];
  gotos: CallRef[];
  fallsThrough: boolean;     // reaches the next label without RETURN/STOP/GOTO
  hasCode: boolean;
  terminatedAt?: { line: number; word: string };
  unreachable?: { first: number; last: number };
}

export interface Param { name: string; isMatrix: boolean; direction: 'in' | 'out' | 'in/out'; }

export interface FileUse {
  fileName: string;
  variable: string;
  ops: string[];
  lines: number[];
}

export interface ExternalRef { kind: 'CALL' | 'DEFFUN' | 'EXECUTE' | 'PERFORM'; name: string; lines: number[]; dynamic: boolean; }

export interface Warning { line?: number; message: string; }

export interface Metrics {
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  labels: number;
  gosubs: number;
  gotos: number;
  maxNesting: number;
}

export type ProgramType = 'PROGRAM' | 'SUBROUTINE' | 'FUNCTION' | 'MAIN';

export interface ProgramModel {
  name: string;
  type: ProgramType;
  headerLine?: number;
  params: Param[];
  returns?: string;
  segments: Segment[];
  labelIndex: Map<string, Segment>;
  gosubTargets: Set<string>;
  gotoTargets: Set<string>;
  files: FileUse[];
  includes: { text: string; line: number }[];
  commons: { name: string; line: number }[];
  equates: { name: string; line: number }[];
  externals: ExternalRef[];
  summaryLines: string[];
  metrics: Metrics;
  warnings: Warning[];
}

export type Flag = 'unreachable' | 'recursive' | 'seeAbove' | 'notFound' | 'onGosub' | 'depthLimit';

export interface TreeNode {
  name: string;
  defLine?: number;
  calledLine?: number;
  flags: Flag[];
  children: TreeNode[];
}

// ---------------------------------------------------------------------------
// Tokenising

const NAME = '[A-Za-z0-9._$%]+';
const LABEL_ALPHA = /^\s*([A-Za-z][A-Za-z0-9._$%]*)\s*:(?!=)/;
const LABEL_NUM = /^\s*(\d+(?:\.\d+)?)(?:\s*:)?(?=\s|;|$)/;
const COMMENT_START = /^(\*|!|REM(\s|$))/i;

function splitStatements(text: string, lineNo: number): { stmts: Stmt[]; hasComment: boolean } {
  const stmts: Stmt[] = [];
  let hasComment = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    if (COMMENT_START.test(text.slice(i))) { hasComment = true; break; }
    let raw = '';
    let code = '';
    let quote: string | null = null;
    for (; i < n; i++) {
      const c = text[i];
      if (quote) {
        raw += c;
        if (c === quote) { quote = null; code += c; } else code += ' ';
      } else if (c === '"' || c === "'" || c === '\\') {
        quote = c; raw += c; code += c;
      } else if (c === ';') {
        i++;
        break;
      } else {
        raw += c; code += c;
      }
    }
    if (raw.trim()) stmts.push({ line: lineNo, raw: raw.trim(), code: code.trim() });
  }
  return { stmts, hasComment };
}

function tokenise(text: string): LineInfo[] {
  const physical = text.replace(/\r\n?/g, '\n').split('\n');
  if (physical.length > 1 && physical[physical.length - 1] === '') physical.pop();
  const lines: LineInfo[] = [];
  let carry: Stmt | null = null;
  physical.forEach((raw, idx) => {
    const no = idx + 1;
    const info: LineInfo = { no, raw, stmts: [], isCommentLine: false, isBlank: raw.trim() === '', isContinuation: false };
    let rest = raw;
    if (!info.isBlank && COMMENT_START.test(raw.trim())) {
      info.isCommentLine = true;
      lines.push(info);
      return;
    }
    if (!carry && !info.isBlank) {
      const m = LABEL_ALPHA.exec(raw) || LABEL_NUM.exec(raw);
      if (m) {
        info.label = m[1];
        rest = raw.slice(m[0].length);
      }
    }
    const { stmts } = splitStatements(rest, no);
    if (carry && stmts.length) {
      const first = stmts.shift()!;
      carry.raw += ' ' + first.raw;
      carry.code += ' ' + first.code;
      info.isContinuation = true;
      if (stmts.length === 0 && /,$/.test(carry.code)) { lines.push(info); return; }
      carry = null;
    }
    info.stmts = stmts;
    const last = stmts[stmts.length - 1];
    carry = last && /,$/.test(last.code) ? last : carry;
    lines.push(info);
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function wordRe(name: string, flags = 'gi'): RegExp {
  return new RegExp(`(?<![A-Za-z0-9._$%])${escapeRe(name)}(?![A-Za-z0-9._$%])`, flags);
}

function splitTargets(list: string): string[] {
  return list.split(',').map(t => t.trim().replace(/:$/, '')).filter(Boolean);
}

function normLabel(l: string): string {
  return /^\d+(\.\d+)?$/.test(l) ? String(parseFloat(l)) : l;
}

function cleanComment(raw: string): string {
  return raw.trim().replace(/^(REM\b|\*+|!+)\s?/i, '').replace(/\s*\*+$/, '').trim();
}

const TERMINATOR = /^(RETURN\b|STOP[EM]?\b|ABORT[EM]?\b|CHAIN\b|GO(\s*TO)?\s+[A-Z0-9._$%]+:?$)/;

/** Block nesting change for one statement (code already upper-cased, trimmed). */
function depthChange(u: string, depth: number): { delta: number; programEnd: boolean } {
  if (u === 'END') return depth > 0 ? { delta: -1, programEnd: false } : { delta: 0, programEnd: true };
  if (/^END\s+CASE$/.test(u)) return { delta: -1, programEnd: false };
  if (/^END\b.*\b(THEN|ELSE)$/.test(u)) return { delta: 0, programEnd: false };
  if (/^BEGIN\s+CASE$/.test(u)) return { delta: 1, programEnd: false };
  if (/^LOOP\b/.test(u)) return { delta: /\bREPEAT$/.test(u) ? 0 : 1, programEnd: false };
  if (/\bREPEAT$/.test(u)) return { delta: -1, programEnd: false };
  if (/^FOR\b/.test(u)) return { delta: /\bNEXT\b/.test(u) ? 0 : 1, programEnd: false };
  if (/^NEXT\b/.test(u)) return { delta: -1, programEnd: false };
  if (/\b(THEN|ELSE|LOCKED)$/.test(u) || /\bON\s+ERROR$/.test(u)) return { delta: 1, programEnd: false };
  return { delta: 0, programEnd: false };
}

// ---------------------------------------------------------------------------
// Analysis

export function parseProgram(text: string, fallbackName: string): ProgramModel {
  const lines = tokenise(text);
  const allStmts = lines.flatMap(l => l.stmts);
  const warnings: Warning[] = [];

  // Pass 1: GOSUB / GOTO targets (needed to decide where routines start).
  const gosubTargets = new Set<string>();
  const gotoTargets = new Set<string>();
  for (const s of allStmts) {
    for (const m of s.code.matchAll(new RegExp(`\\bGOSUB\\s+(${NAME}:?(?:\\s*,\\s*${NAME}:?)*)`, 'gi'))) {
      splitTargets(m[1]).forEach(t => gosubTargets.add(normLabel(t)));
    }
    for (const m of s.code.matchAll(new RegExp(`\\b(?:GO(?:\\s*TO)?|RETURN\\s+TO)\\s+(${NAME}:?(?:\\s*,\\s*${NAME}:?)*)`, 'gi'))) {
      splitTargets(m[1]).forEach(t => gotoTargets.add(normLabel(t)));
    }
  }

  // Header
  let name = fallbackName;
  let type: ProgramType = 'MAIN';
  let headerLine: number | undefined;
  let headerStmt: Stmt | undefined;
  let params: Param[] = [];
  const firstCode = allStmts.find(s => !/^\$/.test(s.code));
  if (firstCode) {
    const p = /^\s*PROGRAM\s+(\S+)/i.exec(firstCode.raw);
    const sf = /^\s*(SUBROUTINE|SUB|FUNCTION)\s+([A-Za-z0-9._$%]+)\s*(?:\((.*)\))?/i.exec(firstCode.raw);
    if (p) { name = p[1]; type = 'PROGRAM'; headerLine = firstCode.line; headerStmt = firstCode; }
    else if (sf) {
      name = sf[2];
      type = /^FUNCTION$/i.test(sf[1]) ? 'FUNCTION' : 'SUBROUTINE';
      headerLine = firstCode.line;
      headerStmt = firstCode;
      if (sf[3] && sf[3].trim()) {
        params = sf[3].split(',').map(a => a.trim()).filter(Boolean).map(a => {
          const mat = /^MAT\s+(.+)$/i.exec(a);
          return { name: mat ? mat[1].trim() : a, isMatrix: !!mat, direction: 'in' as const };
        });
      }
    }
  }

  // Pass 2: segments, reachability, nesting, references.
  const segments: Segment[] = [];
  const labelIndex = new Map<string, Segment>();
  const files = new Map<string, FileUse>();
  const includes: { text: string; line: number }[] = [];
  const commons: { name: string; line: number }[] = [];
  const equates: { name: string; line: number }[] = [];
  const externals = new Map<string, ExternalRef>();
  let returns: string | undefined;

  const newSeg = (label: string | null, line: number): Segment =>
    ({ label, line, endLine: line, gosubs: [], gotos: [], fallsThrough: true, hasCode: false });
  let seg = newSeg(null, 1);
  segments.push(seg);
  let depth = 0;
  let maxNesting = 0;
  let reachable = true;
  let programEnded = false;
  let imbalance = false;

  const addExternal = (kind: ExternalRef['kind'], extName: string, line: number, dynamic: boolean) => {
    const key = kind + ' ' + extName.toUpperCase();
    const e = externals.get(key) ?? { kind, name: extName, lines: [], dynamic };
    if (!e.lines.includes(line)) e.lines.push(line);
    externals.set(key, e);
  };
  const fileFor = (variable: string): FileUse => {
    const key = variable.toUpperCase();
    let f = files.get(key);
    if (!f) { f = { fileName: `? (opened elsewhere as ${variable})`, variable, ops: [], lines: [] }; files.set(key, f); }
    return f;
  };
  const noteFileOp = (variable: string, op: string, line: number) => {
    const f = fileFor(variable);
    if (!f.ops.includes(op)) f.ops.push(op);
    if (!f.lines.includes(line)) f.lines.push(line);
  };

  for (const info of lines) {
    if (info.label !== undefined) {
      const label = normLabel(info.label);
      seg.endLine = info.no - 1;
      seg.fallsThrough = reachable && !programEnded;
      seg = newSeg(label, info.no);
      segments.push(seg);
      if (labelIndex.has(label)) {
        warnings.push({ line: info.no, message: `Duplicate label ${label} (first defined on line ${labelIndex.get(label)!.line}); the first one is used.` });
      } else {
        labelIndex.set(label, seg);
      }
      if (gosubTargets.has(label) && depth > 0) { imbalance = true; depth = 0; }
      // A label after END means that END really closed a block we failed to see opening.
      if (programEnded) { programEnded = false; imbalance = true; }
      reachable = true;
    }
    // On one physical line, everything after THEN/ELSE/LOCKED/ON ERROR belongs to that clause,
    // e.g. "OPEN 'X' TO F ELSE ERR = 1 ; RETURN" – that RETURN is conditional.
    let inLineClause = false;
    for (const s of info.stmts) {
      if (s === headerStmt) continue;
      const u = s.code.toUpperCase().trim();
      if (programEnded) { programEnded = false; reachable = true; imbalance = true; }
      const r = reachable;
      seg.hasCode = true;
      if (!r && !programEnded && u !== 'END') {
        seg.unreachable = seg.unreachable
          ? { first: seg.unreachable.first, last: s.line }
          : { first: s.line, last: s.line };
      }

      // Internal transfers
      const onGosub = /\bON\b.*\bGOSUB\b/i.test(s.code);
      for (const m of s.code.matchAll(new RegExp(`\\bGOSUB\\s+(${NAME}:?(?:\\s*,\\s*${NAME}:?)*)`, 'gi'))) {
        const targets = splitTargets(m[1]);
        for (const t of targets) seg.gosubs.push({ target: normLabel(t), line: s.line, reachable: r, viaOn: onGosub || targets.length > 1 });
      }
      for (const m of s.code.matchAll(new RegExp(`\\b(?:GO(?:\\s*TO)?|RETURN\\s+TO)\\s+(${NAME}:?(?:\\s*,\\s*${NAME}:?)*)`, 'gi'))) {
        for (const t of splitTargets(m[1])) seg.gotos.push({ target: normLabel(t), line: s.line, reachable: r, viaOn: /\bON\b/i.test(s.code) });
      }

      // External references
      for (const m of s.code.matchAll(/\bCALL\s+(@?[A-Za-z0-9._$%]+)/gi)) addExternal('CALL', m[1], s.line, m[1].startsWith('@'));
      const def = /^\s*DEFFUN\s+([A-Za-z0-9._$%]+)/i.exec(s.code);
      if (def) addExternal('DEFFUN', def[1], s.line, false);
      const ex = /^\s*(EXECUTE|PERFORM)\s+(.+)$/i.exec(s.raw);
      if (ex) {
        const what = ex[2].trim();
        addExternal(ex[1].toUpperCase() as 'EXECUTE' | 'PERFORM', what.length > 60 ? what.slice(0, 57) + '…' : what, s.line, !/^["'\\]/.test(what));
      }

      // Files
      const open = /^\s*OPEN\s+(?:(["'\\])(.*?)\1\s*,\s*)?(?:(["'\\])(.*?)\3|([A-Za-z][A-Za-z0-9._$%]*))\s*(?:TO\s+([A-Za-z][A-Za-z0-9._$%]*))?/i.exec(s.raw);
      if (open) {
        const dict = (open[2] ?? '').toUpperCase() === 'DICT' ? 'DICT ' : '';
        const fname = open[4] !== undefined ? open[4] : `(variable ${open[5]})`;
        const variable = open[6] ?? '(default file)';
        const f = fileFor(variable);
        if (f.fileName.startsWith('?')) f.fileName = dict + fname;
        noteFileOp(variable, 'OPEN', s.line);
      }
      const rw = /^\s*(MATREADU|MATREADL|MATREAD|READVU|READVL|READV|READU|READL|READ|MATWRITEU|MATWRITE|WRITEVU|WRITEV|WRITEU|WRITE)\s+.*?\b(?:FROM|ON|TO)\s+([A-Za-z][A-Za-z0-9._$%]*)\s*,/i.exec(s.code);
      if (rw) noteFileOp(rw[2], rw[1].toUpperCase(), s.line);
      const del = /^\s*(DELETEU|DELETE)\s+([A-Za-z][A-Za-z0-9._$%]*)\s*,/i.exec(s.code);
      if (del) noteFileOp(del[2], del[1].toUpperCase(), s.line);
      const sel = /^\s*(SSELECT|SELECT|CLEARFILE)\s+([A-Za-z][A-Za-z0-9._$%]*)/i.exec(s.code);
      if (sel && files.has(sel[2].toUpperCase())) noteFileOp(sel[2], sel[1].toUpperCase(), s.line);
      if (/^\s*(READU|READVU|MATREADU)\b/i.test(s.code) && !/\bLOCKED\b/i.test(s.code)) {
        warnings.push({ line: s.line, message: `${/^\s*(\S+)/.exec(s.code)![1].toUpperCase()} has no LOCKED clause, so the program waits if the record is locked by another user.` });
      }

      // Includes, common, equates
      const inc = /^\s*(\$INCLUDE|\$INSERT|INCLUDE)\s+(.+)$/i.exec(s.raw);
      if (inc) includes.push({ text: `${inc[1].toUpperCase()} ${inc[2].trim()}`, line: s.line });
      const com = /^\s*COM(?:MON)?\s+(?!=)(?:\/\s*([A-Za-z0-9._$%]+)\s*\/)?/i.exec(s.code);
      if (com) commons.push({ name: com[1] ? `/${com[1]}/` : '(unnamed)', line: s.line });
      const equ = /^\s*EQU(?:ATE)?\s+(.+)$/i.exec(s.code);
      if (equ) {
        for (const part of equ[1].split(',')) {
          const e = /^\s*([A-Za-z][A-Za-z0-9._$%]*)\s+(?:TO|LIT|LITERALLY)\b/i.exec(part);
          if (e) equates.push({ name: e[1], line: s.line });
        }
      }
      if (type === 'FUNCTION' && returns === undefined) {
        const ret = /^\s*RETURN\s*\((.*)\)\s*$/i.exec(s.raw);
        if (ret) returns = ret[1].trim();
      }

      // Control flow
      if (depth === 0 && !inLineClause && reachable && TERMINATOR.test(u)) {
        reachable = false;
        seg.terminatedAt = { line: s.line, word: /^(\S+)/.exec(u)![1] };
      }
      if (/\b(THEN|ELSE|LOCKED)\b|\bON\s+ERROR\b/.test(u)) inLineClause = true;
      const dc = depthChange(u, depth);
      if (dc.programEnd) { programEnded = true; reachable = false; }
      depth += dc.delta;
      if (depth < 0) { depth = 0; imbalance = true; }
      maxNesting = Math.max(maxNesting, depth);
    }
  }
  seg.endLine = lines.length;
  seg.fallsThrough = reachable && !programEnded;
  if (depth !== 0) imbalance = true;

  // Parameter direction (best guess)
  const bodyStmts = allStmts.filter(s => s !== headerStmt);
  params = params.map(p => {
    const nm = escapeRe(p.name);
    const assignRe = new RegExp(
      `(?:^|\\b(?:THEN|ELSE|LOCKED)\\s+)(?:MAT\\s+)?${nm}\\s*(?:<[^>]*>|\\([^)]*\\))?\\s*(?:=|\\+=|-=|\\*=|\\/=|:=)` +
      `|^\\s*(?:MAT)?(?:READ[A-Z]*|INPUT)\\s+${nm}(?![A-Za-z0-9._$%])` +
      `|^\\s*FOR\\s+${nm}\\s*=|\\bSETTING\\s+${nm}(?![A-Za-z0-9._$%])`, 'i');
    let assigns = 0;
    let uses = 0;
    for (const s of bodyStmts) {
      const count = (s.code.match(wordRe(p.name)) ?? []).length;
      uses += count;
      if (count && assignRe.test(s.code)) assigns++;
    }
    const direction: Param['direction'] = assigns === 0 ? 'in' : uses > assigns ? 'in/out' : 'out';
    return { ...p, direction };
  });

  // Summary: leading comment block (before or just after the header).
  const summaryLines: string[] = [];
  for (const info of lines) {
    if (info.stmts.length && !(headerStmt && info.stmts[0] === headerStmt && info.stmts.length === 1) && !info.isContinuation) break;
    if (info.isCommentLine) {
      const c = cleanComment(info.raw);
      if (c && !/^[-=*#_~+.\s]+$/.test(c)) summaryLines.push(c);
      if (summaryLines.length >= 12) break;
    }
  }

  // Warnings that need the whole picture
  for (const s of segments) {
    for (const g of s.gosubs) {
      if (!findLabel(labelIndex, g.target)) warnings.push({ line: g.line, message: `GOSUB ${g.target}: label not found in this program.` });
    }
    for (const g of s.gotos) {
      if (!findLabel(labelIndex, g.target)) warnings.push({ line: g.line, message: `GOTO ${g.target}: label not found in this program.` });
    }
    if (s.unreachable) {
      const where = s.label ? `routine ${s.label}` : 'the main program';
      const range = s.unreachable.first === s.unreachable.last ? `Line ${s.unreachable.first}` : `Lines ${s.unreachable.first}–${s.unreachable.last}`;
      warnings.push({ line: s.unreachable.first, message: `${range} in ${where} can never run: ${s.terminatedAt?.word ?? 'RETURN'} on line ${s.terminatedAt?.line} always exits first.` });
    }
  }
  segments.forEach((s, i) => {
    const next = segments[i + 1];
    if (!next || !s.fallsThrough || !s.hasCode) return;
    const sIsRoutine = s.label === null || gosubTargets.has(s.label);
    if (sIsRoutine && next.label && gosubTargets.has(next.label)) {
      const who = s.label ? `Routine ${s.label}` : 'The main program';
      warnings.push({ line: next.line, message: `${who} has no RETURN/STOP before label ${next.label} (line ${next.line}), so it runs on into ${next.label}.` });
    }
  });
  segments.forEach((s, i) => {
    if (s.label === null) return;
    if (labelIndex.get(s.label) !== s) return;
    const referenced = gosubTargets.has(s.label) || gotoTargets.has(s.label);
    const prev = segments[i - 1];
    const fallsIn = prev && prev.fallsThrough && (prev.hasCode || i === 1);
    if (!referenced && !fallsIn) warnings.push({ line: s.line, message: `Label ${s.label} is never called by GOSUB or reached by GOTO (dead code).` });
  });
  for (const e of externals.values()) {
    if (e.kind === 'CALL' && e.dynamic) warnings.push({ line: e.lines[0], message: `CALL ${e.name} is a dynamic call; the routine is chosen at run time and cannot be resolved here.` });
  }
  if (imbalance) warnings.push({ message: 'Block nesting (IF/THEN … END, LOOP … REPEAT, FOR … NEXT, BEGIN CASE … END CASE) looks unbalanced; reachability results may be less accurate.' });
  warnings.sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9));

  const totalLines = lines.length;
  const blankLines = lines.filter(l => l.isBlank).length;
  const commentLines = lines.filter(l => l.isCommentLine).length;
  return {
    name, type, headerLine, params, returns,
    segments, labelIndex, gosubTargets, gotoTargets,
    files: [...files.values()].map(f => ({ ...f, lines: [...f.lines].sort((a, b) => a - b) })),
    includes, commons, equates,
    externals: [...externals.values()],
    summaryLines,
    metrics: {
      totalLines,
      codeLines: totalLines - blankLines - commentLines,
      commentLines,
      blankLines,
      labels: segments.length - 1,
      gosubs: segments.reduce((n, s) => n + s.gosubs.length, 0),
      gotos: segments.reduce((n, s) => n + s.gotos.length, 0),
      maxNesting,
    },
    warnings,
  };
}

export function findLabel(index: Map<string, Segment>, target: string): Segment | undefined {
  const exact = index.get(target);
  if (exact) return exact;
  const upper = target.toUpperCase();
  for (const [k, v] of index) if (k.toUpperCase() === upper) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// Routines and call tree

/** Segments that make up a routine: its own segment plus code it falls into or GOTOs (not other GOSUB routines). */
export function routineSegments(model: ProgramModel, entry: Segment): Segment[] {
  const seen = new Set<Segment>();
  const queue = [entry];
  while (queue.length) {
    const s = queue.shift()!;
    if (seen.has(s)) continue;
    seen.add(s);
    const idx = model.segments.indexOf(s);
    const next = model.segments[idx + 1];
    if (s.fallsThrough && next && !(next.label && model.gosubTargets.has(next.label))) queue.push(next);
    for (const g of s.gotos) {
      const t = findLabel(model.labelIndex, g.target);
      if (t && !(t.label && model.gosubTargets.has(t.label))) queue.push(t);
    }
  }
  return [...seen].sort((a, b) => a.line - b.line);
}

export function routineGosubs(model: ProgramModel, entry: Segment): CallRef[] {
  return routineSegments(model, entry).flatMap(s => s.gosubs);
}

/** Builds a pattern test for routine names: case-insensitive, `*` = any characters, `?` = one character. */
export function makeExcluder(patterns: readonly string[] | undefined): (name: string) => boolean {
  const res = (patterns ?? []).map(p => String(p).trim()).filter(Boolean).map(p =>
    new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
  return name => res.some(r => r.test(name));
}

/** Call tree from the main body down. `isExcluded` hides matching routines and everything called only through them. */
export function buildCallTree(model: ProgramModel, maxDepth = 10, isExcluded: (name: string) => boolean = () => false): TreeNode {
  const expanded = new Set<string>();
  const visible = (g: CallRef) => {
    const t = findLabel(model.labelIndex, g.target);
    return !isExcluded(t?.label ?? g.target);
  };
  const kids = (entry: Segment, path: string[], depth: number): TreeNode[] =>
    routineGosubs(model, entry).filter(visible).map(g => {
      const node: TreeNode = { name: g.target, calledLine: g.line, flags: [], children: [] };
      if (!g.reachable) node.flags.push('unreachable');
      if (g.viaOn) node.flags.push('onGosub');
      const t = findLabel(model.labelIndex, g.target);
      if (!t || t.label === null) { node.flags.push('notFound'); return node; }
      node.name = t.label;
      node.defLine = t.line;
      const hasKids = routineGosubs(model, t).some(visible);
      if (path.includes(t.label)) node.flags.push('recursive');
      else if (expanded.has(t.label)) { if (hasKids) node.flags.push('seeAbove'); }
      else if (depth >= maxDepth) { if (hasKids) node.flags.push('depthLimit'); }
      else {
        expanded.add(t.label);
        node.children = kids(t, [...path, t.label], depth + 1);
      }
      return node;
    });
  return { name: model.name, flags: [], children: kids(model.segments[0], [], 1) };
}
