export interface Notifier {
  syncFailed(error: string): Promise<void>;
  syncRecovered(): Promise<void>;
  consentExpiring(input: { aspsp: string; validUntil: string; daysLeft: number }): Promise<void>;
  consentExpired(input: { aspsp: string }): Promise<void>;
  exportFailed(error: string, tokenExpired: boolean): Promise<void>;
  exportRecovered(): Promise<void>;
}
