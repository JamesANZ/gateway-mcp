/**
 * @title Per-backend circuit
 * @notice Remembers which backends have stopped answering, so one dead
 *         process does not hold a tool-call slot for the full timeout.
 * @dev The map lives in this process, like the rate limit. A second replica
 *      has its own copy. A backend starts unknown, and unknown does not
 *      reject a call. Two transport failures open the circuit. A successful
 *      probe or a successful tool call closes it and zeros the counter.
 *      Fifteen seconds after it opens, one trial call is allowed through.
 *      That trial is how `npm start` recovers when nothing polls `/readyz`.
 *      Kubernetes and Compose already probe every few seconds, and a
 *      successful probe closes the circuit without waiting for the trial.
 */

/**
 * @notice Transport failures that open the circuit.
 * @dev One blip still pays the normal timeout. The second one stops trying.
 */
const FAILURES_TO_OPEN = 2;

/**
 * @notice How long an open circuit waits before allowing one trial call.
 * @dev Exported so the test can move a fake clock to this instant.
 */
export const TRIAL_AFTER_MS = 15_000;

/**
 * @notice One backend's failure streak.
 * @param failures Consecutive transport failures. An application error
 *        does not change this number.
 * @param openedAt When the circuit opened, or when a later transport
 *        failure restarted the cooldown. Absent while the circuit is closed.
 * @param ready Last `/readyz` result. Absent until the first probe.
 * @param trial True after the half-open call has been handed out and has
 *        not finished. A second concurrent call still fails fast.
 */
interface Circuit {
  failures: number;
  openedAt?: number;
  ready?: boolean;
  trial: boolean;
}

/**
 * @notice Health of every backend this process has probed or called.
 */
export class BackendHealth {
  private readonly circuits = new Map<string, Circuit>();

  /**
   * @param now Clock, replaced in tests so they do not sleep for 15 seconds.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * @notice Record one `/readyz` probe.
   * @param id Backend id from config.
   * @param ready True when that probe returned HTTP 200.
   * @returns True when this is a new ready bit, so the caller can log once.
   * @dev A failed probe is a transport failure. A successful probe closes
   *      the circuit, which is the usual recovery under Kubernetes.
   */
  recordProbe(id: string, ready: boolean): boolean {
    const circuit = this.circuitFor(id);
    const changed = circuit.ready !== ready;
    circuit.ready = ready;
    if (ready) {
      this.close(circuit);
    } else {
      this.noteTransport(circuit);
    }
    return changed;
  }

  /**
   * @notice Count a connection failure, a timeout, or HTTP 502, 503, or 504.
   * @param id Backend id from config.
   * @dev A JSON-RPC tool error is not passed here. The backend process
   *      answered, so that must not open the circuit for its other tools.
   */
  recordTransportFailure(id: string): void {
    this.noteTransport(this.circuitFor(id));
  }

  /**
   * @notice The backend completed a tool call.
   * @param id Backend id from config.
   * @dev Closes the circuit. Used for a successful tools/call and for a
   *      successful tools/list, both of which mean the process is answering.
   */
  recordSuccess(id: string): void {
    this.close(this.circuitFor(id));
  }

  /**
   * @notice The backend answered with a tool error or an HTTP status we do
   *         not treat as "down".
   * @param id Backend id from config.
   * @dev Does not open, close, or change the failure count. It only releases
   *      the single-trial lock, so a half-open call that got a normal tool
   *      error does not block the next caller forever.
   */
  recordApplicationFailure(id: string): void {
    const circuit = this.circuits.get(id);
    if (!circuit) {
      return;
    }
    circuit.trial = false;
  }

  /**
   * @notice Whether tools/call must fail without fetching.
   * @param id Backend id from config. An id we have never seen is unknown.
   * @returns True when the circuit is open and this call is not the trial.
   * @dev The first call after the cooldown is the trial. This method marks
   *      it before returning, and a second call in the same moment is rejected.
   *      Node runs this synchronously, so the check and the mark cannot interleave.
   */
  rejectCall(id: string): boolean {
    const circuit = this.circuits.get(id);
    if (!circuit || circuit.openedAt === undefined) {
      return false;
    }
    if (circuit.trial) {
      return true;
    }
    if (this.now() - circuit.openedAt >= TRIAL_AFTER_MS) {
      circuit.trial = true;
      return false;
    }
    return true;
  }

  /**
   * @notice Find or create the row for this backend.
   * @param id Backend id.
   * @returns The mutable circuit. New rows are closed and unknown.
   */
  private circuitFor(id: string): Circuit {
    const existing = this.circuits.get(id);
    if (existing) {
      return existing;
    }
    const created: Circuit = { failures: 0, trial: false };
    this.circuits.set(id, created);
    return created;
  }

  /**
   * @notice Count one transport failure and open or refresh the cooldown.
   * @param circuit Row to update.
   * @dev Each failure while the circuit is open moves `openedAt` to now.
   *      A probe that keeps failing therefore holds the circuit shut, and
   *      the trial is not sent at a backend we already know is down.
   */
  private noteTransport(circuit: Circuit): void {
    circuit.failures += 1;
    circuit.trial = false;
    if (circuit.failures >= FAILURES_TO_OPEN) {
      circuit.openedAt = this.now();
    }
  }

  /**
   * @notice Forget the failure streak.
   * @param circuit Row to close.
   */
  private close(circuit: Circuit): void {
    circuit.failures = 0;
    circuit.openedAt = undefined;
    circuit.trial = false;
  }
}
