import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { Focus, FullSession, ProjectInfo, SessionSummary } from './types';
import { Sidebar } from './components/Sidebar';
import { SessionHeader, FilesPanel } from './components/SessionHeader';
import { Timeline } from './components/Timeline';
import { ReviewPanel } from './components/ReviewPanel';
import { NewSessionDialog } from './components/NewSessionDialog';
import { FollowUpBar } from './components/FollowUpBar';

type Tab = 'timeline' | 'files' | 'review';

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessionsRoot, setSessionsRoot] = useState('');
  const [canReveal, setCanReveal] = useState(false); // "reveal in file manager" available (loopback only)
  const [loading, setLoading] = useState(true);
  // Collapse the left session list (desktop) to give the conversation more width.
  // On mobile the master-detail layout already hides it, so this only affects desktop.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('csv.sbCollapsed') === '1');
  const toggleSidebar = useCallback(
    () =>
      setSidebarCollapsed((v) => {
        localStorage.setItem('csv.sbCollapsed', v ? '0' : '1');
        return !v;
      }),
    [],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // On phones/tablets we show either the list or the detail, not both. Desktop
  // (>~820px) ignores this via CSS and shows both.
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');
  const [session, setSession] = useState<FullSession | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  const [live, setLive] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [pulse, setPulse] = useState(false); // brief "just got an update" flag
  const [serverActive, setServerActive] = useState(false); // a claude process is running for this session
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set()); // all running sessions (machine-wide)

  const unsubRef = useRef<(() => void) | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The id of the most recent openSession() request, so a slow response for a
  // previously-selected session can't overwrite the one the user just clicked.
  const openReqRef = useRef<string | null>(null);

  // Called on every live snapshot: refresh the session and flash "working" for a
  // few seconds. Combined with tailPending below, this reads as "actively working"
  // both while Claude streams text/thinking and while a tool is mid-execution.
  const onSessionUpdate = useCallback((s: FullSession) => {
    setSession(s);
    setPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulse(false), 6000);
  }, []);

  // True when the newest tool call has no result yet — Claude fired a tool and is
  // waiting on / running it (no transcript update arrives during that gap).
  const tailPending = useMemo(() => {
    if (!session) return false;
    let lastCall: (typeof session.events)[number] | undefined;
    const results = new Set<string>();
    for (const e of session.events) {
      if (e.kind === 'tool_result' && e.forToolUseId) results.add(e.forToolUseId);
      if (e.kind === 'tool_call') lastCall = e;
    }
    if (!lastCall?.toolUseId || results.has(lastCall.toolUseId)) return false;
    // Age-gate: a dangling tool_call from a session that died mid-tool (window
    // closed, crash — no result ever written) would otherwise spin "working…"
    // forever. Only treat it as in-flight if it's recent.
    const ts = lastCall.ts ? Date.parse(lastCall.ts) : NaN;
    if (!isNaN(ts) && Date.now() - ts > 5 * 60_000) return false;
    return true;
  }, [session]);

  // `serverActive` is authoritative for turns launched/resumed through this tool
  // (the CLI process is alive the whole turn, including thinking). pulse/tailPending
  // are the transcript-based fallback for sessions driven elsewhere.
  const working = live && (serverActive || pulse || tailPending);

  const refreshList = useCallback(async () => {
    const [{ sessions }, { projects, sessionsRoot, reveal }] = await Promise.all([api.sessions(), api.projects()]);
    setSessions(sessions);
    setProjects(projects);
    setSessionsRoot(sessionsRoot);
    setCanReveal(reveal);
    setLoading(false);
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // Machine-wide "which sessions are running" feed → sidebar indicators. Refresh the
  // list when the running set changes so counts/updated-times stay current for
  // sessions we're not actively viewing.
  useEffect(() => {
    return api.activityStream((ids) => {
      setActiveIds(new Set(ids));
      refreshList();
    });
  }, [refreshList]);

  const stopLive = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    setPulse(false);
    setServerActive(false);
  }, []);

  // Terminal stream conditions (deleted transcript, permanently closed connection):
  // leave live mode so the UI doesn't claim "Live" over stale data forever.
  const onStreamEnd = useCallback(
    (reason: string) => {
      stopLive();
      setLive(false);
      if (reason === 'deleted') {
        setSelectedId(null);
        setSession(null);
        setMobilePane('list');
        refreshList();
      }
    },
    [stopLive, refreshList],
  );

  const goLive = useCallback(
    (id: string) => {
      setLive(true);
      unsubRef.current = api.stream(id, onSessionUpdate, setServerActive, onStreamEnd);
    },
    [onSessionUpdate, onStreamEnd],
  );

  const openSession = useCallback(
    async (id: string) => {
      stopLive();
      setLive(false);
      setFocus(null);
      setTab('timeline');
      setSelectedId(id);
      setMobilePane('detail');
      setSession(null);
      openReqRef.current = id;
      try {
        const s = await api.session(id);
        if (openReqRef.current === id) setSession(s); // ignore a stale, slower response
      } catch {
        if (openReqRef.current === id) setSession(null);
      }
    },
    [stopLive],
  );

  const toggleLive = useCallback(() => {
    if (!selectedId) return;
    if (live) {
      stopLive();
      setLive(false);
      return;
    }
    goLive(selectedId);
  }, [selectedId, live, stopLive, goLive]);

  useEffect(() => () => stopLive(), [stopLive]);

  const onLaunched = useCallback(
    async (id: string) => {
      setShowNew(false);
      await refreshList();
      await openSession(id);
      goLive(id);
    },
    [openSession, refreshList, goLive],
  );

  // After a follow-up turn is sent, make sure we're tailing so the continuation streams in.
  const onFollowUp = useCallback(() => {
    if (selectedId && !live) goLive(selectedId);
  }, [selectedId, live, goLive]);

  const onDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id);
      } catch (e) {
        alert(`Could not delete session: ${e instanceof Error ? e.message : e}`);
        return;
      }
      if (id === selectedId) {
        stopLive();
        setLive(false);
        setSelectedId(null);
        setSession(null);
        setMobilePane('list');
      }
      await refreshList();
    },
    [selectedId, stopLive, refreshList],
  );

  const defaultCwd = session?.cwd || projects[0]?.cwdGuess || '';

  return (
    <div className={`app mobile-${mobilePane} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        sessions={sessions}
        projects={projects}
        selectedId={selectedId}
        activeIds={activeIds}
        onSelect={openSession}
        onNew={() => setShowNew(true)}
        onDelete={onDelete}
        onToggleCollapse={toggleSidebar}
        loading={loading}
      />
      {sidebarCollapsed && (
        <button className="sidebar-expand" onClick={toggleSidebar} title="Show sessions">
          ☰
        </button>
      )}

      <main className="main">
        {!session && (
          <div className="empty">
            <div className="empty-inner">
              <div className="empty-logo">◈</div>
              <h2>Claude Session Viewer</h2>
              <p>Pick a session on the left to see its decision map, or start a new one.</p>
              <p className="muted mono">watching: {sessionsRoot}</p>
            </div>
          </div>
        )}

        {session && (
          <>
            <SessionHeader
              session={session}
              live={live}
              working={working}
              onBack={() => setMobilePane('list')}
              onToggleLive={toggleLive}
              tab={tab}
              onTab={setTab}
              focus={focus}
              onInspect={setFocus}
            />
            <div className="content-area">
              {tab === 'timeline' && (
                <Timeline session={session} focus={focus} onClearFocus={() => setFocus(null)} />
              )}
              {tab === 'files' && <FilesPanel session={session} canReveal={canReveal} />}
              {tab === 'review' && <ReviewPanel id={session.id} />}
            </div>
            <FollowUpBar session={session} onSent={onFollowUp} active={live && serverActive} />
          </>
        )}
      </main>

      {showNew && (
        <NewSessionDialog defaultCwd={defaultCwd} onClose={() => setShowNew(false)} onLaunched={onLaunched} />
      )}
    </div>
  );
}
