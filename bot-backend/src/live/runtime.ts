import { getSetting, setSetting } from "../db.js";
import { getMediaTimers, mediaExists, type MediaSlot } from "./media.js";
import { clearLiveSession, getLiveSession, setSessionStatus, type SessionStatus } from "./session.js";

const K_PHASE = "live.runtime.phase";
const K_STARTED = "live.runtime.started_at";
const K_FIRST = "live.runtime.first_output_at";
const K_LOST = "live.runtime.lost_at";
const K_ENDING = "live.runtime.ending_at";

export type RuntimePhase = "idle" | "prepared" | "waiting_obs" | "live" | "brb" | "ending";

export type RelaySource =
  | { mode: "off" }
  | { mode: "ingest" }
  | { mode: "filler"; slot: MediaSlot };

export type RuntimeView = {
  phase: RuntimePhase;

  status: SessionStatus;
  label: string;
  detail: string;
  remainingMs: number | null;
  timers: ReturnType<typeof getMediaTimers>;
  hasFirstOutput: boolean;
  source: RelaySource;
};

function numSetting(key: string): number {
  const n = Number(getSetting(key) || "0");
  return Number.isFinite(n) ? n : 0;
}

export function getRuntimePhase(): RuntimePhase {
  const raw = getSetting(K_PHASE) || "";
  if (
    raw === "prepared" ||
    raw === "waiting_obs" ||
    raw === "live" ||
    raw === "brb" ||
    raw === "ending"
  ) {
    return raw;
  }
  const s = getLiveSession().status;
  if (s === "prepared") return "prepared";
  if (s === "live") return "live";
  return "idle";
}

function setPhase(phase: RuntimePhase): void {
  setSetting(K_PHASE, phase);
  if (phase === "idle") setSessionStatus("idle");
  else if (phase === "prepared") setSessionStatus("prepared");
  else setSessionStatus("live");
}

export function isSessionForwarding(): boolean {
  const p = getRuntimePhase();
  return p === "waiting_obs" || p === "live" || p === "brb" || p === "ending";
}

export function markPrepared(): void {
  setPhase("prepared");
  setSetting(K_STARTED, "0");
  setSetting(K_FIRST, "0");
  setSetting(K_LOST, "0");
  setSetting(K_ENDING, "0");
}

export function markStarted(): void {
  setPhase("waiting_obs");
  setSetting(K_STARTED, String(Date.now()));
  setSetting(K_FIRST, "0");
  setSetting(K_LOST, "0");
  setSetting(K_ENDING, "0");
}

export function clearRuntime(): void {
  setPhase("idle");
  setSetting(K_STARTED, "0");
  setSetting(K_FIRST, "0");
  setSetting(K_LOST, "0");
  setSetting(K_ENDING, "0");
}


export function beginEnding(): void {
  setPhase("ending");
  setSetting(K_ENDING, String(Date.now()));
  setSetting(K_LOST, "0");
}

function fmtRemain(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

let endingFinishLock = false;





export function tickRuntime(
  obsPresent: boolean,
  onEndComplete?: () => void | Promise<void>
): RuntimeView {
  const timers = getMediaTimers();
  let phase = getRuntimePhase();
  const startedAt = numSetting(K_STARTED);
  let firstAt = numSetting(K_FIRST);
  let lostAt = numSetting(K_LOST);
  const endingAt = numSetting(K_ENDING);
  const now = Date.now();

  if (phase === "idle" || phase === "prepared") {
    return view(phase, null, { mode: "off" }, timers, firstAt > 0);
  }

  if (phase === "waiting_obs") {
    if (obsPresent) {
      firstAt = now;
      setSetting(K_FIRST, String(now));
      setPhase("live");
      phase = "live";
    } else {
      const deadline = startedAt + timers.startWaitMs;
      const remain = deadline - now;
      if (remain <= 0) {
        beginEnding();
        phase = "ending";
      } else {
        const source: RelaySource = mediaExists("start")
          ? { mode: "filler", slot: "start" }
          : { mode: "off" };
        return view(
          "waiting_obs",
          remain,
          source,
          timers,
          false,
          "Waiting for OBS",
          mediaExists("start")
            ? `Starting soon video looping · ${fmtRemain(remain)} until auto-end`
            : `No start media — waiting for OBS · ${fmtRemain(remain)} until auto-end`
        );
      }
    }
  }

  if (phase === "live") {
    if (obsPresent) {
      if (lostAt) setSetting(K_LOST, "0");
      return view("live", null, { mode: "ingest" }, timers, true, "Live", "OBS connected — forwarding");
    }
    if (!lostAt) {
      lostAt = now;
      setSetting(K_LOST, String(now));
    }

    setPhase("brb");
    phase = "brb";
  }

  if (phase === "brb") {
    if (obsPresent) {
      setSetting(K_LOST, "0");
      setPhase("live");
      return view("live", null, { mode: "ingest" }, timers, true, "Live", "OBS returned — forwarding");
    }
    const brbStart = lostAt || now;
    const deadline = brbStart + timers.brbWaitMs;
    const remain = deadline - now;
    if (remain <= 0) {
      beginEnding();
      phase = "ending";
    } else {
      const source: RelaySource = mediaExists("idle")
        ? { mode: "filler", slot: "idle" }
        : { mode: "off" };
      return view(
        "brb",
        remain,
        source,
        timers,
        true,
        "Idle / BRB",
        mediaExists("idle")
          ? `Be right back looping · ${fmtRemain(remain)} left`
          : `OBS down · ${fmtRemain(remain)} until end credits`
      );
    }
  }

  if (phase === "ending") {
    const endStart = endingAt || now;
    if (!endingAt) setSetting(K_ENDING, String(now));
    const deadline = endStart + timers.endPlayMs;
    const remain = deadline - now;
    if (remain <= 0) {
      if (!endingFinishLock) {
        endingFinishLock = true;
        void Promise.resolve(onEndComplete?.())
          .catch(() => undefined)
          .finally(() => {
            endingFinishLock = false;
            clearRuntime();
            clearLiveSession();
          });
      }
      return view("ending", 0, { mode: "off" }, timers, firstAt > 0, "Ending", "Closing stream…");
    }
    const source: RelaySource = mediaExists("end")
      ? { mode: "filler", slot: "end" }
      : { mode: "off" };
    return view(
      "ending",
      remain,
      source,
      timers,
      firstAt > 0,
      "Ending",
      mediaExists("end")
        ? `End video · ${fmtRemain(remain)} then complete`
        : `No end media uploaded · holding ${fmtRemain(remain)} then complete`
    );
  }

  return view(phase, null, { mode: "off" }, timers, firstAt > 0);
}

function view(
  phase: RuntimePhase,
  remainingMs: number | null,
  source: RelaySource,
  timers: ReturnType<typeof getMediaTimers>,
  hasFirstOutput: boolean,
  label?: string,
  detail?: string
): RuntimeView {
  const status: SessionStatus =
    phase === "idle" ? "idle" : phase === "prepared" ? "prepared" : "live";
  const labels: Record<RuntimePhase, string> = {
    idle: "Idle",
    prepared: "Ready — waiting for Start",
    waiting_obs: "Waiting for OBS",
    live: "Live",
    brb: "Idle / BRB",
    ending: "Ending",
  };
  return {
    phase,
    status,
    label: label || labels[phase],
    detail: detail || "",
    remainingMs,
    timers,
    hasFirstOutput,
    source,
  };
}


export function peekRuntime(): RuntimeView {
  const timers = getMediaTimers();
  const phase = getRuntimePhase();
  const startedAt = numSetting(K_STARTED);
  const firstAt = numSetting(K_FIRST);
  const lostAt = numSetting(K_LOST);
  const endingAt = numSetting(K_ENDING);
  const now = Date.now();

  if (phase === "waiting_obs") {
    const remain = startedAt + timers.startWaitMs - now;
    const source: RelaySource = mediaExists("start")
      ? { mode: "filler", slot: "start" }
      : { mode: "off" };
    return view(
      phase,
      Math.max(0, remain),
      source,
      timers,
      false,
      "Waiting for OBS",
      `Until first output · ${fmtRemain(Math.max(0, remain))}`
    );
  }
  if (phase === "live") {
    return view(phase, null, { mode: "ingest" }, timers, true, "Live", "OBS connected — forwarding");
  }
  if (phase === "brb") {
    const remain = (lostAt || now) + timers.brbWaitMs - now;
    const source: RelaySource = mediaExists("idle")
      ? { mode: "filler", slot: "idle" }
      : { mode: "off" };
    return view(
      phase,
      Math.max(0, remain),
      source,
      timers,
      true,
      "Idle / BRB",
      `Come back within · ${fmtRemain(Math.max(0, remain))}`
    );
  }
  if (phase === "ending") {
    const remain = (endingAt || now) + timers.endPlayMs - now;
    const source: RelaySource = mediaExists("end")
      ? { mode: "filler", slot: "end" }
      : { mode: "off" };
    return view(
      phase,
      Math.max(0, remain),
      source,
      timers,
      firstAt > 0,
      "Ending",
      `End credits · ${fmtRemain(Math.max(0, remain))}`
    );
  }
  if (phase === "prepared") {
    return view(phase, null, { mode: "off" }, timers, false, "Ready — waiting for Start", "Click Start stream when ready");
  }
  return view("idle", null, { mode: "off" }, timers, false, "Idle", "Create a stream to begin");
}
