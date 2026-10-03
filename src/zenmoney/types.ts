// Subset of the ZenMoney API this service touches.
// Reference: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API
// Timestamps are Unix seconds; amounts are plain decimals, always >= 0.

export interface ZmInstrument {
  id: number;
  shortTitle: string;
}

export interface ZmUser {
  id: number;
  currency: number;
  parent: number | null;
}

export interface ZmAccount {
  id: string;
  user: number;
  instrument: number | null;
  type: string;
  title: string;
  syncID: string[] | null;
  archive: boolean;
}

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
  instrument?: ZmInstrument[];
  user?: ZmUser[];
  account?: ZmAccount[];
  transaction?: ZmTransaction[];
}

export interface ZmSuggestion {
  payee?: string | null;
  merchant?: string | null;
  tag?: string[] | null;
}

/** What the exporter needs from the client — small so tests can fake it. */
export interface ZenMoneyApi {
  diff(body: ZmDiff): Promise<ZmDiff>;
  suggest(items: { payee: string }[]): Promise<ZmSuggestion[]>;
}
