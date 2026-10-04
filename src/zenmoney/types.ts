// Subset of the ZenMoney API this service touches. Responses are parsed with
// these schemas, and only for the fields the exporter reads — nothing read
// from ZenMoney is ever written back, so unknown fields can be dropped.
// Reference: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API
// Timestamps are Unix seconds; amounts are plain decimals, always >= 0.

import * as v from 'valibot';

/** A token only works on the server that issued it (zerro.app: `zm_server` in localStorage). */
export const ZenMoneyServerSchema = v.picklist(['ru', 'app']);
export type ZenMoneyServer = v.InferOutput<typeof ZenMoneyServerSchema>;

const InstrumentSchema = v.object({
  id: v.number(),
  shortTitle: v.string(),
});
export type ZmInstrument = v.InferOutput<typeof InstrumentSchema>;

const AccountSchema = v.object({
  id: v.string(),
  user: v.number(),
  instrument: v.nullish(v.number(), null),
  type: v.string(),
  title: v.string(),
  syncID: v.nullish(v.array(v.string()), null),
  archive: v.boolean(),
});
export type ZmAccount = v.InferOutput<typeof AccountSchema>;

/** Built by us, never read back — so a plain type, not a schema. */
export interface ZmTransaction {
  id: string;
  changed: number;
  created: number;
  user: number;
  deleted: boolean;
  hold: boolean | null;
  viewed: boolean;
  incomeInstrument: number;
  incomeAccount: string;
  income: number;
  outcomeInstrument: number;
  outcomeAccount: string;
  outcome: number;
  tag: string[] | null;
  merchant: string | null;
  payee: string | null;
  originalPayee: string | null;
  comment: string | null;
  date: string;
  mcc: number | null;
  reminderMarker: string | null;
  opIncome: number | null;
  opIncomeInstrument: number | null;
  opOutcome: number | null;
  opOutcomeInstrument: number | null;
  latitude: number | null;
  longitude: number | null;
  incomeBankID: string | null;
  outcomeBankID: string | null;
  qrCode: string | null;
}

export interface ZmDiff {
  serverTimestamp: number;
  currentClientTimestamp?: number;
  forceFetch?: string[];
  transaction?: ZmTransaction[];
}

/** Only the tables asked for (or changed since `serverTimestamp`) are present. */
export const ZmDiffResponseSchema = v.object({
  instrument: v.optional(v.array(InstrumentSchema)),
  account: v.optional(v.array(AccountSchema)),
});
export type ZmDiffResponse = v.InferOutput<typeof ZmDiffResponseSchema>;

const SuggestionSchema = v.object({
  payee: v.nullish(v.string()),
  merchant: v.nullish(v.string()),
  tag: v.nullish(v.array(v.string())),
});
export type ZmSuggestion = v.InferOutput<typeof SuggestionSchema>;

export const ZmSuggestResponseSchema = v.array(SuggestionSchema);

/** What the exporter needs from the client — small so tests can fake it. */
export interface ZenMoneyApi {
  diff(body: ZmDiff): Promise<ZmDiffResponse>;
  suggest(items: { payee: string }[]): Promise<ZmSuggestion[]>;
}
