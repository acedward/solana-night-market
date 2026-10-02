// A small client for a proof server (midnightntwrk/proof-server). The relay talks to TWO of them
// until stagenet moves to dust/10 (AA 00047 spike 3 §6, ../config.ts): the CONTRACT prover
// 9.0.0-rc.8 (the account's compactc 0.35.0 circuits) and the DUST prover 9.0.0-rc.6 (the sponsor
// wallet's fee payments).
//
// Proving itself goes through midnight-js's HTTP proof provider (the contract prover, which gets
// the prover key streamed from the key volume with each /prove call) and the wallet SDK (the DUST
// prover). This client covers what the relay needs around them: version and readiness for
// /health, and the capacity each server reports.

export interface ProofServerReady {
  status: string;
  jobsProcessing: number;
  jobsPending: number;
  jobCapacity: number;
}

export interface ProofServerProbe {
  reachable: boolean;
  version: string | null;
  jobCapacity: number | null;
  versionMatches: boolean | null;
}

export class ProofServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly expectedVersion: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`proof server ${path} answered ${res.status}`);
    return res;
  }

  async version(): Promise<string> {
    return (await (await this.get('/version')).text()).trim().replace(/^"|"$/g, '');
  }

  async proofVersions(): Promise<string[]> {
    return (await (await this.get('/proof-versions')).json()) as string[];
  }

  async ready(): Promise<ProofServerReady> {
    return (await (await this.get('/ready')).json()) as ProofServerReady;
  }

  async probe(): Promise<ProofServerProbe> {
    try {
      const [version, ready] = await Promise.all([this.version(), this.ready()]);
      return {
        reachable: true,
        version,
        jobCapacity: typeof ready.jobCapacity === 'number' ? ready.jobCapacity : null,
        versionMatches: this.expectedVersion === null ? null : version === this.expectedVersion,
      };
    } catch {
      return { reachable: false, version: null, jobCapacity: null, versionMatches: null };
    }
  }
}
