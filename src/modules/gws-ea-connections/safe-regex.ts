/**
 * Linear-time Thompson NFA matcher for evaluating untrusted JSON Schema `patternProperties` keys
 * without calling `new RegExp(untrusted)` (preventing ReDoS / CWE-1333 stalls).
 */

export type SafeRegexResult = 'match' | 'no_match' | 'unsupported' | 'invalid';

const MAX_PATTERN_LENGTH = 256;
const MAX_NFA_STATES = 256;
const MAX_REPEAT_EXPAND = 32;

type CharPredicate = (code: number) => boolean;

type AstNode =
  | { readonly kind: 'empty' }
  | { readonly kind: 'char'; readonly match: CharPredicate }
  | { readonly kind: 'anchor'; readonly anchor: 'start' | 'end' | 'word' | 'non_word' }
  | { readonly kind: 'seq'; readonly items: readonly AstNode[] }
  | { readonly kind: 'alt'; readonly branches: readonly AstNode[] }
  | { readonly kind: 'repeat'; readonly body: AstNode; readonly min: number; readonly max: number | null };

class ParseAbort extends Error {
  constructor(readonly outcome: 'invalid' | 'unsupported') {
    super(outcome);
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isWord(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f
  );
}

function isSpace(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0xfeff ||
    code === 0x2028 ||
    code === 0x2029
  );
}

function isDotChar(code: number): boolean {
  return code !== 0x0a && code !== 0x0d && code !== 0x2028 && code !== 0x2029;
}

function hexValue(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

class RegexParser {
  private pos = 0;

  constructor(private readonly pattern: string) {}

  parse(): AstNode {
    const node = this.parseAlt();
    if (this.pos !== this.pattern.length) throw new ParseAbort('invalid');
    return node;
  }

  private peek(): string | undefined {
    return this.pattern[this.pos];
  }

  private parseAlt(): AstNode {
    const branches: AstNode[] = [this.parseSeq()];
    while (this.peek() === '|') {
      this.pos += 1;
      branches.push(this.parseSeq());
    }
    return branches.length === 1 ? branches[0]! : { kind: 'alt', branches };
  }

  private parseSeq(): AstNode {
    const items: AstNode[] = [];
    while (this.pos < this.pattern.length) {
      const ch = this.peek();
      if (ch === '|' || ch === ')') break;
      items.push(this.parseQuantified());
    }
    if (items.length === 0) return { kind: 'empty' };
    return items.length === 1 ? items[0]! : { kind: 'seq', items };
  }

  private parseQuantified(): AstNode {
    const atom = this.parseAtom();
    const ch = this.peek();
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      if (atom.kind === 'anchor') throw new ParseAbort('invalid');
      const quant = this.parseQuantifier();
      if (quant === null) return atom;
      // Optional lazy modifier '?' does not affect boolean match existence.
      if (this.peek() === '?') this.pos += 1;
      // Reject chained quantifiers such as a** or a{1,2}+ or a{1}{2}.
      const next = this.peek();
      if (next === '*' || next === '+' || next === '?' || (next === '{' && this.parseQuantifier() !== null)) {
        throw new ParseAbort('invalid');
      }
      return { kind: 'repeat', body: atom, min: quant.min, max: quant.max };
    }
    return atom;
  }

  private parseQuantifier(): { readonly min: number; readonly max: number | null } | null {
    const ch = this.peek();
    if (ch === '*') {
      this.pos += 1;
      return { min: 0, max: null };
    }
    if (ch === '+') {
      this.pos += 1;
      return { min: 1, max: null };
    }
    if (ch === '?') {
      this.pos += 1;
      return { min: 0, max: 1 };
    }
    if (ch === '{') {
      const saved = this.pos;
      this.pos += 1;
      const min = this.readDigits();
      if (min === null) {
        this.pos = saved;
        return null;
      }
      if (this.peek() === '}') {
        this.pos += 1;
        if (min > MAX_REPEAT_EXPAND) throw new ParseAbort('unsupported');
        return { min, max: min };
      }
      if (this.peek() === ',') {
        this.pos += 1;
        if (this.peek() === '}') {
          this.pos += 1;
          if (min > MAX_REPEAT_EXPAND) throw new ParseAbort('unsupported');
          return { min, max: null };
        }
        const max = this.readDigits();
        if (max !== null && this.peek() === '}') {
          this.pos += 1;
          if (max < min) throw new ParseAbort('invalid');
          if (max > MAX_REPEAT_EXPAND) throw new ParseAbort('unsupported');
          return { min, max };
        }
      }
      this.pos = saved;
      return null;
    }
    return null;
  }

  private readDigits(): number | null {
    const start = this.pos;
    while (this.pos < this.pattern.length && isDigit(this.pattern.charCodeAt(this.pos))) {
      this.pos += 1;
    }
    if (this.pos === start) return null;
    const value = Number(this.pattern.slice(start, this.pos));
    return Number.isSafeInteger(value) ? value : MAX_REPEAT_EXPAND + 1;
  }

  private parseAtom(): AstNode {
    const ch = this.peek();
    if (ch === undefined) throw new ParseAbort('invalid');
    if (ch === '*' || ch === '+' || ch === '?') throw new ParseAbort('invalid');
    if (ch === '^') {
      this.pos += 1;
      return { kind: 'anchor', anchor: 'start' };
    }
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'anchor', anchor: 'end' };
    }
    if (ch === '.') {
      this.pos += 1;
      return { kind: 'char', match: isDotChar };
    }
    if (ch === '(') {
      this.pos += 1;
      if (this.peek() === '?') {
        if (this.pattern.slice(this.pos, this.pos + 2) === '?:') {
          this.pos += 2;
        } else {
          throw new ParseAbort('unsupported');
        }
      }
      const inner = this.parseAlt();
      if (this.peek() !== ')') throw new ParseAbort('invalid');
      this.pos += 1;
      return inner;
    }
    if (ch === '[') {
      return this.parseCharClass();
    }
    if (ch === '\\') {
      return this.parseEscapeOutsideClass();
    }
    this.pos += 1;
    const code = ch.charCodeAt(0);
    return { kind: 'char', match: (c) => c === code };
  }

  private parseEscapeOutsideClass(): AstNode {
    this.pos += 1;
    const ch = this.peek();
    if (ch === undefined) throw new ParseAbort('invalid');
    if (ch === 'b') {
      this.pos += 1;
      return { kind: 'anchor', anchor: 'word' };
    }
    if (ch === 'B') {
      this.pos += 1;
      return { kind: 'anchor', anchor: 'non_word' };
    }
    if (ch >= '1' && ch <= '9') throw new ParseAbort('unsupported');
    if (ch === 'k' || ch === 'p' || ch === 'P' || ch === 'c') throw new ParseAbort('unsupported');
    const pred = this.parseEscapePredicate();
    return { kind: 'char', match: pred };
  }

  private parseEscapeCharCode(): number | null {
    const ch = this.peek();
    if (ch === undefined) throw new ParseAbort('invalid');
    if (ch === 'd' || ch === 'D' || ch === 'w' || ch === 'W' || ch === 's' || ch === 'S') return null;
    if (ch === 'p' || ch === 'P' || ch === 'c') throw new ParseAbort('unsupported');
    this.pos += 1;
    switch (ch) {
      case 't':
        return 0x09;
      case 'n':
        return 0x0a;
      case 'v':
        return 0x0b;
      case 'f':
        return 0x0c;
      case 'r':
        return 0x0d;
      case '0': {
        const next = this.peek();
        if (next !== undefined && isDigit(next.charCodeAt(0))) throw new ParseAbort('unsupported');
        return 0x00;
      }
      case 'x': {
        const value = this.readHex(2);
        return value === null ? 0x78 : value;
      }
      case 'u': {
        if (this.peek() === '{') throw new ParseAbort('unsupported');
        const value = this.readHex(4);
        return value === null ? 0x75 : value;
      }
      default:
        return ch.charCodeAt(0);
    }
  }

  private parseEscapePredicate(): CharPredicate {
    const ch = this.peek();
    if (ch === 'd') {
      this.pos += 1;
      return isDigit;
    }
    if (ch === 'D') {
      this.pos += 1;
      return (c) => !isDigit(c);
    }
    if (ch === 'w') {
      this.pos += 1;
      return isWord;
    }
    if (ch === 'W') {
      this.pos += 1;
      return (c) => !isWord(c);
    }
    if (ch === 's') {
      this.pos += 1;
      return isSpace;
    }
    if (ch === 'S') {
      this.pos += 1;
      return (c) => !isSpace(c);
    }
    const code = this.parseEscapeCharCode();
    if (code === null) throw new ParseAbort('invalid');
    return (c) => c === code;
  }

  private readHex(count: number): number | null {
    if (this.pos + count > this.pattern.length) return null;
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      const digit = hexValue(this.pattern[this.pos + i]!);
      if (digit < 0) return null;
      total = (total << 4) | digit;
    }
    this.pos += count;
    return total;
  }

  private parseCharClass(): AstNode {
    this.pos += 1; // skip '['
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.pos += 1;
    }
    const predicates: CharPredicate[] = [];
    while (this.pos < this.pattern.length && this.peek() !== ']') {
      const startItem = this.readClassAtom();
      if (
        this.peek() === '-' &&
        this.pos + 1 < this.pattern.length &&
        this.pattern[this.pos + 1] !== ']' &&
        startItem.code !== null
      ) {
        this.pos += 1; // skip '-'
        const endItem = this.readClassAtom();
        if (endItem.code === null) {
          // ECMA-262 annex B treats a range involving a class escape like [\d-a] as literals, or unsupported.
          throw new ParseAbort('unsupported');
        }
        const lo = startItem.code;
        const hi = endItem.code;
        if (hi < lo) throw new ParseAbort('invalid');
        predicates.push((c) => c >= lo && c <= hi);
      } else {
        predicates.push(startItem.pred);
      }
    }
    if (this.peek() !== ']') throw new ParseAbort('invalid');
    this.pos += 1;
    const match: CharPredicate = (code) => {
      for (const pred of predicates) {
        if (pred(code)) return !negated;
      }
      return negated;
    };
    return { kind: 'char', match };
  }

  private readClassAtom(): { readonly code: number | null; readonly pred: CharPredicate } {
    const ch = this.peek();
    if (ch === undefined) throw new ParseAbort('invalid');
    if (ch === '\\') {
      this.pos += 1;
      const escaped = this.peek();
      if (escaped === 'b') {
        this.pos += 1;
        return { code: 0x08, pred: (c) => c === 0x08 };
      }
      const code = this.parseEscapeCharCode();
      if (code !== null) return { code, pred: (c) => c === code };
      return { code: null, pred: this.parseEscapePredicate() };
    }
    this.pos += 1;
    const code = ch.charCodeAt(0);
    return { code, pred: (c) => c === code };
  }
}

type NfaState =
  | { readonly kind: 'accept' }
  | { readonly kind: 'split'; readonly out1: number; readonly out2: number }
  | { readonly kind: 'epsilon'; readonly out: number }
  | { readonly kind: 'anchor'; readonly anchor: 'start' | 'end' | 'word' | 'non_word'; readonly out: number }
  | { readonly kind: 'char'; readonly match: CharPredicate; readonly out: number };

class NfaCompiler {
  readonly states: NfaState[] = [];

  private addState(state: NfaState): number {
    if (this.states.length >= MAX_NFA_STATES) throw new ParseAbort('unsupported');
    this.states.push(state);
    return this.states.length - 1;
  }

  compile(node: AstNode, next: number): number {
    switch (node.kind) {
      case 'empty':
        return next;
      case 'char':
        return this.addState({ kind: 'char', match: node.match, out: next });
      case 'anchor':
        return this.addState({ kind: 'anchor', anchor: node.anchor, out: next });
      case 'seq': {
        let target = next;
        for (let i = node.items.length - 1; i >= 0; i -= 1) {
          target = this.compile(node.items[i]!, target);
        }
        return target;
      }
      case 'alt': {
        let combined = this.compile(node.branches[node.branches.length - 1]!, next);
        for (let i = node.branches.length - 2; i >= 0; i -= 1) {
          const left = this.compile(node.branches[i]!, next);
          combined = this.addState({ kind: 'split', out1: left, out2: combined });
        }
        return combined;
      }
      case 'repeat': {
        let target = next;
        if (node.max === null) {
          // Unbounded tail: 0 or more repetitions.
          const splitIndex = this.addState({ kind: 'epsilon', out: target });
          const bodyStart = this.compile(node.body, splitIndex);
          this.states[splitIndex] = { kind: 'split', out1: bodyStart, out2: target };
          target = splitIndex;
        } else {
          const optionalCount = node.max - node.min;
          for (let i = 0; i < optionalCount; i += 1) {
            const bodyStart = this.compile(node.body, target);
            target = this.addState({ kind: 'split', out1: bodyStart, out2: target });
          }
        }
        for (let i = 0; i < node.min; i += 1) {
          target = this.compile(node.body, target);
        }
        return target;
      }
    }
  }
}

function anchorMatches(anchor: 'start' | 'end' | 'word' | 'non_word', subject: string, index: number): boolean {
  switch (anchor) {
    case 'start':
      return index === 0;
    case 'end':
      return index === subject.length;
    case 'word': {
      const left = index > 0 && isWord(subject.charCodeAt(index - 1));
      const right = index < subject.length && isWord(subject.charCodeAt(index));
      return left !== right;
    }
    case 'non_word': {
      const left = index > 0 && isWord(subject.charCodeAt(index - 1));
      const right = index < subject.length && isWord(subject.charCodeAt(index));
      return left === right;
    }
  }
}

function addClosure(
  states: readonly NfaState[],
  startIds: readonly number[],
  subject: string,
  index: number,
): { readonly active: number[]; readonly accepted: boolean } {
  const visited = new Uint8Array(states.length);
  const stack = [...startIds];
  const active: number[] = [];
  let accepted = false;
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited[id] === 1) continue;
    visited[id] = 1;
    const state = states[id]!;
    switch (state.kind) {
      case 'accept':
        accepted = true;
        break;
      case 'epsilon':
        stack.push(state.out);
        break;
      case 'split':
        stack.push(state.out2, state.out1);
        break;
      case 'anchor':
        if (anchorMatches(state.anchor, subject, index)) stack.push(state.out);
        break;
      case 'char':
        active.push(id);
        break;
    }
  }
  return { active, accepted };
}

/**
 * Tests an untrusted ECMA-262 pattern against `subject` in guaranteed linear time.
 * Returns `'unsupported'` for exotic constructs (lookarounds, backreferences, large repeats/NFA)
 * and `'invalid'` for syntax errors, so callers can handle both without risking ReDoS.
 */
export function testSafeRegex(pattern: string, subject: string): SafeRegexResult {
  if (pattern.length > MAX_PATTERN_LENGTH) return 'unsupported';
  let ast: AstNode;
  try {
    ast = new RegexParser(pattern).parse();
  } catch (error) {
    if (error instanceof ParseAbort) return error.outcome;
    throw error;
  }

  const unanchored: AstNode = {
    kind: 'seq',
    items: [{ kind: 'repeat', body: { kind: 'char', match: () => true }, min: 0, max: null }, ast],
  };

  const compiler = new NfaCompiler();
  let startState: number;
  try {
    const acceptState = compiler.states.push({ kind: 'accept' }) - 1;
    startState = compiler.compile(unanchored, acceptState);
  } catch (error) {
    if (error instanceof ParseAbort) return error.outcome;
    throw error;
  }

  let step = addClosure(compiler.states, [startState], subject, 0);
  if (step.accepted) return 'match';

  for (let i = 0; i < subject.length; i += 1) {
    if (step.active.length === 0) return 'no_match';
    const code = subject.charCodeAt(i);
    const nextSeeds: number[] = [];
    for (const id of step.active) {
      const state = compiler.states[id]!;
      if (state.kind === 'char' && state.match(code)) {
        nextSeeds.push(state.out);
      }
    }
    step = addClosure(compiler.states, nextSeeds, subject, i + 1);
    if (step.accepted) return 'match';
  }

  return 'no_match';
}
