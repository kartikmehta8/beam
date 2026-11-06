/**
 * @file Builds intents on the device: the shared `prepareTransfer` against
 * this phone's chain and ENS clients, then the device-only approval reasons.
 *
 * Every intent the app shows comes from here, whether the agent proposed it,
 * the offline parser found it, or an external agent sent a review link.
 */
import { formatUnits, type Address } from 'viem';
import { transferDeps } from './chain';
import { config, NETWORK } from './config';
import { isTransferError, prepareTransfer, type Intent, type IntentOrigin, type ScreenContextInput, type TransferError } from './intent';
import { getNames, getRecipients } from './storage';
import { scanInjection } from './injection';
import { withDeviceReasons } from './validateIntent';

/** Copy shown while this build has no BeamPay address. */
export const BEAMPAY_MISSING = "BeamPay isn't deployed for this network yet.";

/** One payment to prepare. */
type DeviceRequest = {
  id: string;
  /** 0x address or ENS name, as found. */
  to: string;
  /** Decimal amount in `NETWORK.symbol`. */
  amount: string;
  wallet: Address;
  /** Daily limit left, in wei. */
  remainingWei: bigint;
  context: ScreenContextInput | null;
  userTexts: string[];
  parsedBy: Intent['parsedBy'];
  origin: IntentOrigin;
};

/**
 * Wei as a decimal string with at most `NETWORK.amountDecimals` digits (truncated), as `parseAmount` expects.
 * @param wei Amount in wei.
 * @returns e.g. "87.5".
 */
export function toDecimal(wei: bigint): string {
  const [int, frac = ''] = formatUnits(wei, 18).split('.');
  const cut = frac.slice(0, NETWORK.amountDecimals).replace(/0+$/, '');
  return cut ? `${int}.${cut}` : int;
}

/**
 * Prepares and annotates one intent on the device.
 * @param req The payment.
 * @returns The intent, or a `TransferError` whose message is user-facing copy.
 */
export async function prepareOnDevice(req: DeviceRequest): Promise<Intent | TransferError> {
  if (req.context && scanInjection(req.context.text).suspected) {
    return { error: 'PROMPT_INJECTION_BLOCKED', message: 'Payment from this captured context is blocked. Enter the recipient and amount manually to continue.' };
  }
  if (!config.beamPay) return { error: 'RPC_ERROR', message: BEAMPAY_MISSING };
  const result = await prepareTransfer(transferDeps, {
    id: req.id,
    to: req.to,
    amount: req.amount,
    wallet: req.wallet,
    dailyRemaining: toDecimal(req.remainingWei),
    context: req.context,
    userTexts: req.userTexts,
    parsedBy: req.parsedBy,
    origin: req.origin,
    network: NETWORK,
    beamPay: config.beamPay,
  });
  if (isTransferError(result)) return result;
  const [knownRecipients, names] = await Promise.all([getRecipients(), getNames()]);
  return withDeviceReasons(result, { knownRecipients, names });
}
