/**
 * @file Narrow, deterministic indicators of instructions embedded in untrusted
 * screen, clipboard or external-agent context. A match warrants review; no match
 * does not establish that content is safe. This is not a complete injection defense.
 *
 * SHARED FILE: byte-identical copies live at app/src/injection.ts and
 * server/src/injection.ts. The shared-file test guards against drift.
 * Do not scan the user's own instructions as third-party context.
 */

export const INJECTION_SIGNALS = ['instruction_override', 'role_spoofing', 'concealment', 'recipient_redirect'] as const;
export type InjectionSignal = (typeof INJECTION_SIGNALS)[number];
export type InjectionAssessment = { suspected: boolean; signals: InjectionSignal[] };

/** Fixed copy: never display an attacker-controlled explanation as a verdict. */
export const INJECTION_COPY: Readonly<Record<InjectionSignal, string>> = {
  instruction_override: 'This text may be trying to override Beam\'s instructions or approval checks.',
  role_spoofing: 'This text may be impersonating system or developer instructions.',
  concealment: 'This text may be asking Beam to hide information or act without your approval.',
  recipient_redirect: 'This text may be trying to replace the intended payment recipient.',
};

/** Current context boundaries are 4,000 characters. Bound work even for other callers. */
const MAX_SCAN_CHARS = 16_000;

// Look for commands at a sentence/line boundary, including common quote/list
// wrappers. A quote is not an exemption: a standalone quoted instruction is
// still ambiguous untrusted content. Ordinary prose mentioning attacks is not a command.
const COMMAND = '(?:^|[.!?;\\n])[ \\t]*(?:(?:[-*>]|\\d{1,2}[.)])[ \\t]*)?["\'`\\u201c\\u2018]?[ \\t]*(?:please[ \\t]+)?';
const command = (body: string): RegExp => new RegExp(COMMAND + body, 'i');

/** Bounded gaps and a fixed input cap avoid regex work growing without limit. */
const PATTERNS: readonly (readonly [InjectionSignal, RegExp])[] = [
  [
    'instruction_override',
    command('(?:ignore|disregard|override|forget)[ \\t]+(?:(?:all|any|the|your)[ \\t]+){0,2}(?:(?:previous|prior|earlier|above|system|developer|safety|security)[ \\t]+){1,2}(?:instructions?|prompts?|rules?|polic(?:y|ies)|messages?)\\b'),
  ],
  ['instruction_override', command('(?:ignore|disregard|override)[ \\t]+(?:all[ \\t]+)?instructions?[ \\t]+(?:above|before|so far)\\b')],
  [
    'instruction_override',
    command('(?:bypass|disable|skip|turn off)[ \\t]+(?:(?:the|your|all|any)[ \\t]+)?(?:safety|security|approval|confirmation|risk|user|human)[ \\t]+(?:checks?|rules?|safeguards?|verification|confirmation|approval|warnings?)\\b'),
  ],
  ['instruction_override', command('(?:bypass|disable|skip)[ \\t]+(?:(?:the|your|all|any)[ \\t]+)?(?:confirmation|approval|verification)\\b')],
  ['instruction_override', command('(?:call|invoke|run|execute)[ \\t]+(?:the[ \\t]+)?(?:prepare_payment|assess_screen|inspect_recipient)\\b')],
  [
    'role_spoofing',
    /(?:^|\n)[ \t]*(?:\[\/?(?:system|developer)\]|<\/?(?:system|developer)>|<\|(?:im_start|start_header_id)\|>[ \t]*(?:system|developer)\b|(?:new[ \t]+)?(?:system|developer)(?:[ \t]+(?:message|prompt|instructions?|override))?[ \t]*:)/i,
  ],
  ['role_spoofing', command('(?:treat|interpret)[ \\t]+(?:this|the following)[ \\t]+(?:text[ \\t]+|message[ \\t]+)?as[ \\t]+(?:a[ \\t]+|the[ \\t]+)?(?:system|developer)[ \\t]+(?:message|prompt|instruction)\\b')],
  ['role_spoofing', command('(?:you are now|act as|pretend to be)[ \\t]+(?:an?[ \\t]+)?(?:unrestricted|jailbroken|system-level)[ \\t]+(?:assistant|agent|model)\\b')],
  ['concealment', command('(?:do not|don\'t|never)[ \\t]+(?:tell|inform|notify|show|warn)[ \\t]+(?:the[ \\t]+)?(?:user|human|payer|wallet owner)\\b')],
  ['concealment', command('(?:hide|conceal|suppress|omit)[ \\t]+(?:(?:this|these|the|all|any)[ \\t]+)?(?:instructions?|warnings?|risks?|recipient|payment details|approval request)\\b')],
  ['concealment', command('(?:send|pay|transfer|execute|approve)\\b[^!?;\\n]{0,100}\\b(?:silently|without[ \\t]+(?:asking|confirmation|approval|notifying|telling))\\b')],
  ['recipient_redirect', command('(?:replace|override|change|swap|substitute)[ \\t]+(?:(?:the|this|that|original|intended|payment)[ \\t]+){0,2}(?:recipient|destination|wallet address|payment address)\\b[^.!?;\\n]{0,60}\\b(?:with|to|for)\\b')],
  ['recipient_redirect', command('(?:send|pay|transfer)\\b[^!?;\\n]{0,100}\\bto[ \\t]+[^!?;\\n]{1,80}\\b(?:instead|rather than)\\b')],
  ['recipient_redirect', command('use[ \\t]+(?:this|the following)[ \\t]+(?:address|wallet|recipient)[ \\t]+instead\\b')],
];

/**
 * Scan known English instruction patterns, never an overall safety verdict.
 * Unicode compatibility normalization and invisible-control removal catch
 * simple obfuscations. Paraphrases, other languages, homoglyphs and text beyond
 * the scan cap can still evade this heuristic; callers must enforce boundaries
 * and approval rules independently of this result.
 */
export function scanInjection(text: string): InjectionAssessment {
  const normalized = text
    .slice(0, MAX_SCAN_CHARS)
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .slice(0, MAX_SCAN_CHARS);
  const signals = INJECTION_SIGNALS.filter((signal) => PATTERNS.some(([kind, pattern]) => kind === signal && pattern.test(normalized)));
  return { suspected: signals.length > 0, signals };
}
