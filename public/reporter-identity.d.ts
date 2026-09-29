export interface MasterReporterIdentity {
  id?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  [key: string]: unknown;
}

export function isValidMasterReporter(reporter: MasterReporterIdentity | null | undefined): boolean;
export function uniqueMasterReporters<T extends MasterReporterIdentity>(reporters?: T[]): T[];
