/**
 * @file `assess_screen`: the model's Scam Shield verdict on the captured screen.
 *
 * The model picks a level and signals from fixed lists, never free text, so
 * screen content cannot write the copy the user sees. The result is merged
 * with the regex floor in `risk.ts`, so the model can raise risk, not lower it.
 */
import { z } from 'zod';
import { mergeAssessment, RISK_LEVELS, RISK_SIGNALS, scanText } from '../risk';
import { defineTool } from './tool';

export const assessScreen = defineTool({
  name: 'assess_screen',
  description: () =>
    'Records your safety verdict on the untrusted get_screen_context result: safe, caution or scam, plus the scam signals you see. ' +
    'Call it when the user asks if something is safe, legit or a scam, and before prepare_payment when the payment comes from screen text. ' +
    'Signals: CREDENTIAL_REQUEST (asks for OTP, PIN, password, seed phrase), REMOTE_ACCESS (install an app, share screen, AnyDesk), ' +
    'PAY_TO_RECEIVE (pay a fee to receive money, refund or prize), TOO_GOOD_TO_BE_TRUE (prize, airdrop, guaranteed returns), ' +
    'URGENCY (act now, account blocked), IMPERSONATION (bank, support, government, police), SUSPICIOUS_LINK (shortened or disguised links). ' +
    'Returns the final verdict to explain in one sentence.',
  input: z.object({
    verdict: z.enum(RISK_LEVELS).describe('safe, caution or scam.'),
    signals: z.array(z.enum(RISK_SIGNALS)).max(RISK_SIGNALS.length).describe('Signals present on screen. Empty when none.'),
  }),
  run: async (ctx, { verdict, signals }) => {
    const floor = ctx.context ? scanText(ctx.context.text) : [];
    ctx.assessment = mergeAssessment(floor, { level: verdict, signals });
    return { ok: true, ...ctx.assessment };
  },
});
