import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Trophy, 
  Users, 
  LayoutDashboard, 
  Settings, 
  Bell, 
  Shield, 
  ShieldOff, 
  Plus, 
  ChevronLeft,
  ChevronRight,
  Search,
  CheckCircle2,
  Check,
  AlertCircle,
  QrCode,
  CreditCard,
  Trash2,
  LogIn,
  LogOut,
  UserPlus,
  Key,
  User as UserIcon,
  Lock,
  Edit2,
  Calendar,
  AlertTriangle,
  Monitor,
  Maximize,
  Minimize,
  RefreshCw,
  X,
  Database,
  Download,
  Play,
  ArrowLeft,
  ClipboardCheck,
  PieChart,
  Layers,
  RotateCcw,
  Pause
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { MatchData, RingStatus, EventData, BoutMapping, MatchHistoryItem, OperationType } from './types';
import { TASheet } from './components/TASheet';
import { InspectionLogs } from './components/InspectionLogs';
import { RingSummary } from './components/RingSummary';
import { AdminMapping } from './components/AdminMapping';
import { AIBracketSetup } from './components/AIBracketSetup';
import { TournamentAssistant } from './components/TournamentAssistant';
import { SearchWinner } from './components/SearchWinner';
import { EventReport } from './components/EventReport';
import { BoutChart } from './components/BoutChart';
import { 
  syncToGoogleSheets as rawSyncToGoogleSheets, 
  updateWinnerInGoogleSheets as rawUpdateWinnerInGoogleSheets, 
  updateBoutDetailsInGoogleSheets as rawUpdateBoutDetailsInGoogleSheets, 
  updatePointsInGoogleSheets as rawUpdatePointsInGoogleSheets, 
  testSync 
} from './services/googleSheets';
import { cn, normalizeBoutNumber, normalizeBoutWithRing, getBoutNumber, formatBoutNumber, isBoutMatch, parseRingNumber, extractWinnerOfBout, getEventSpreadsheetUrl, getEventWebAppUrl } from './lib/utils';
import { collection, addDoc, onSnapshot, query, orderBy, limit, serverTimestamp, doc, setDoc, deleteDoc, getDoc, getDocFromServer, where } from 'firebase/firestore';
import { db, disableFirestoreNetwork, auth } from './firebase';
import Papa from 'papaparse';

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}


function sanitizeForFirestore(obj: any): any {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForFirestore);
  
  const sanitized: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      sanitized[key] = sanitizeForFirestore(obj[key]);
    }
  }
  return sanitized;
}

// Simple deep equality check to prevent redundant writes
function isEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key) || !isEqual(a[key], b[key])) return false;
  }
  return true;
}

function cleanPlaceholder(text?: string): string {
  if (!text) return "---";
  const t = text.trim().toUpperCase();
  const placeholders = ["NEW COMPETITOR", "CLUB A", "CLUB B", "OPEN CATEGORY", "---", "-"];
  if (placeholders.includes(t)) return "---";
  return text;
}

function hasPlayers(bout: MatchData | null | undefined): boolean {
  if (!bout) return false;
  return cleanPlaceholder(bout.blue_name) !== "---" || cleanPlaceholder(bout.red_name) !== "---";
}

export let isFirestoreQuotaExceeded = localStorage.getItem('tkd_disable_firebase') === 'true';

export const handleGlobalQuotaTrigger = () => {
  isFirestoreQuotaExceeded = true;
  disableFirestoreNetwork();
  window.dispatchEvent(new CustomEvent('firestore-quota-exceeded'));
};

export const manuallyDisableFirebase = () => {
  localStorage.setItem('tkd_disable_firebase', 'true');
  handleGlobalQuotaTrigger();
};

export const manuallyEnableFirebase = () => {
  window.dispatchEvent(new CustomEvent('request-reboot'));
};

function useSyncedState<T>(key: string, initialValue: T) {
  const [state, setState] = useState<T>(() => {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return saved as unknown as T;
      }
    }
    return initialValue;
  });

  const lastRemoteValue = useRef<string>('');
  const timeoutRef = useRef<any>(null);
  const latestValueRef = useRef<T>(state);
  const inFlightValueRef = useRef<string | null>(null);

  // Keep latestValueRef synced with the current state as a fallback
  useEffect(() => {
    latestValueRef.current = state;
  }, [state]);

  useEffect(() => {
    if (isFirestoreQuotaExceeded) {
      return;
    }

    let isMounted = true;
    let unsub = () => {};

    const handleQuota = () => {
      handleGlobalQuotaTrigger();
      unsub();
    };

    const handleGlobalQuota = () => {
      unsub();
    };
    window.addEventListener('firestore-quota-exceeded', handleGlobalQuota);

    if (isFirestoreQuotaExceeded) return;
    try {
      unsub = onSnapshot(doc(db, 'sync', key), (document) => {
        if (!isMounted) return;

        if (document.exists()) {
          let remoteValue = document.data().value;
          
          // CRDT Last-Write-Wins Merge for tkd_rings to prevent cross-court state overrides (uses logical version & updatedAt physical fallback)
          if (key === 'tkd_rings' && Array.isArray(remoteValue)) {
            const localRings = (latestValueRef.current || []) as any[];
            const remoteRings = remoteValue as any[];
            
            const allRingNumbers = Array.from(new Set([
              ...localRings.map(r => r.ringNumber),
              ...remoteRings.map(r => r.ringNumber)
            ])).sort((a, b) => a - b);

            const mergedRings = allRingNumbers.map(ringNum => {
              const localRing = localRings.find(r => r.ringNumber === ringNum);
              const remoteRing = remoteRings.find(r => r.ringNumber === ringNum);

              if (!localRing) return remoteRing!;
              if (!remoteRing) return localRing;

              const localVersion = localRing.version || 0;
              const remoteVersion = remoteRing.version || 0;

              if (localVersion > remoteVersion) {
                return localRing;
              } else if (remoteVersion > localVersion) {
                return remoteRing;
              } else {
                // Secondary physical fallback to resolve same version conflicts safely
                const localTime = localRing.updatedAt || 0;
                const remoteTime = remoteRing.updatedAt || 0;
                if (localTime > remoteTime) {
                  return localRing;
                }
                return remoteRing;
              }
            });
            
            const hasLocalNewer = mergedRings.some((mr) => {
              const lr = localRings.find(r => r.ringNumber === mr.ringNumber);
              const rr = remoteRings.find(r => r.ringNumber === mr.ringNumber);
              if (!lr) return false;
              if (!rr) return true; // Local is newer since remote doesn't have it
              
              const localVersion = lr.version || 0;
              const remoteVersion = rr.version || 0;
              
              if (localVersion > remoteVersion) return true;
              if (remoteVersion > localVersion) return false;
              
              return (lr.updatedAt || 0) > (rr.updatedAt || 0);
            });
            
            remoteValue = mergedRings;
            
            if (hasLocalNewer) {
              setTimeout(() => {
                setSyncedState(mergedRings as unknown as T);
              }, 100);
            }
          }

          const remoteValueStr = JSON.stringify(remoteValue);
          
          if (remoteValueStr !== lastRemoteValue.current) {
            // Guard: If we currently have a pending local change (either in the debounce delay
            // or actively in-flight being written to Firestore), do NOT let an older stale remote snapshot
            // overwrite our current local state.
            const hasPendingWrite = timeoutRef.current !== null || inFlightValueRef.current !== null;
            if (hasPendingWrite) {
              const currentPendingStr = JSON.stringify(latestValueRef.current);
              if (remoteValueStr === currentPendingStr || remoteValueStr === inFlightValueRef.current) {
                lastRemoteValue.current = remoteValueStr;
                if (inFlightValueRef.current === remoteValueStr) {
                  inFlightValueRef.current = null;
                }
              }
              // Skip updating state to prevent the flashing-back/jumping visual feedback loop
              return;
            }

            lastRemoteValue.current = remoteValueStr;
            setState(remoteValue);
            localStorage.setItem(key, remoteValueStr);
          }
        }
      }, (error) => {
        if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
          handleQuota();
        } else if (error.code === 'permission-denied' || error.message?.toLowerCase().includes('permission')) {
          handleFirestoreError(error, OperationType.GET, 'sync/' + key);
        } else {
          console.error(`Firestore Sync Error (${key}):`, error);
        }
      });
    } catch (e: any) {
      if (e.code === 'resource-exhausted' || e.message?.toLowerCase().includes('quota')) {
        handleQuota();
      }
    }

    return () => {
      isMounted = false;
      unsub();
      window.removeEventListener('firestore-quota-exceeded', handleGlobalQuota);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [key]);

  const setSyncedState = React.useCallback((updater: T | ((prev: T) => T)) => {
    setState(prev => {
      let newValue = typeof updater === 'function' ? (updater as any)(prev) : updater;
      
      // Inject logical versions & physical timestamps for tkd_rings changes to avoid distributed logical overwrites & clock drift
      if (key === 'tkd_rings') {
        const prevArray = (prev || []) as any[];
        const nextArray = (newValue || []) as any[];
        newValue = nextArray.map((nextRing) => {
          const prevRing = prevArray.find(r => r.ringNumber === nextRing.ringNumber);
          const isChanged = !prevRing || 
            JSON.stringify(prevRing.currentBout) !== JSON.stringify(nextRing.currentBout) ||
            JSON.stringify(prevRing.onDeck) !== JSON.stringify(nextRing.onDeck) ||
            JSON.stringify(prevRing.inTheHole) !== JSON.stringify(nextRing.inTheHole) ||
            prevRing.nextBoutNumber !== nextRing.nextBoutNumber ||
            prevRing.totalBouts !== nextRing.totalBouts ||
            prevRing.isFinalBouts !== nextRing.isFinalBouts;
          
          if (isChanged) {
            // Keep the remote's version and updatedAt if they represent a merged snapshot change already newer than local
            const isRemoteVersionNewer = nextRing.version && nextRing.version > (prevRing?.version || 0);
            const isRemoteTimeNewer = nextRing.updatedAt && nextRing.updatedAt > (prevRing?.updatedAt || 0);
            
            if (isRemoteVersionNewer || isRemoteTimeNewer) {
              return nextRing;
            }
            return {
              ...nextRing,
              version: (prevRing?.version || 0) + 1,
              updatedAt: Date.now()
            };
          }
          return {
            ...nextRing,
            version: nextRing.version || (prevRing && prevRing.version) || 0,
            updatedAt: nextRing.updatedAt || (prevRing && prevRing.updatedAt) || 0
          };
        }) as unknown as T;
      }
      
      // Safety: Only write to local & remote if value actually changed
      if (!isEqual(prev, newValue)) {
        const valStr = JSON.stringify(newValue);
        localStorage.setItem(key, valStr);
        latestValueRef.current = newValue;
        
        // Clear previous pending write to avoid extra intermediate updates
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }

        // Only allow authorized logged-in users (admin, user, ta) to push updates to Firestore 
        // to prevent spectator/viewer/guest clients from overwriting the cloud state.
        const canWriteToCloud = (() => {
          const isPublicUrl = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'public';
          if (isPublicUrl) return false;
          
          const savedUser = localStorage.getItem('tkd_user');
          if (savedUser) {
            try {
              const parsed = JSON.parse(savedUser);
              return ['admin', 'user', 'ta'].includes(parsed?.role);
            } catch (_) {}
          }
          return false; // Strict default: Do NOT allow unlogged-in guest/spectator clients to write settings/states back to the Firestore database
        })();

        // Guard against writing the same value back to Firestore, and ensure user is authorized
        if (canWriteToCloud && valStr !== lastRemoteValue.current) {
          const syncToFirestore = () => {
            timeoutRef.current = null;
            const currentPending = latestValueRef.current;
            const currentStr = JSON.stringify(currentPending);
            
            if (currentStr !== lastRemoteValue.current) {
              // Update the in-flight reference to track active network write
              inFlightValueRef.current = currentStr;
              
              if (!isFirestoreQuotaExceeded) {
                setDoc(doc(db, 'sync', key), { value: sanitizeForFirestore(currentPending) })
                  .then(() => {
                    // Update our last known remote string ONLY after confirmation from Firestore
                    lastRemoteValue.current = currentStr;
                    if (inFlightValueRef.current === currentStr) {
                      inFlightValueRef.current = null;
                    }
                  })
                  .catch(err => {
                    if (inFlightValueRef.current === currentStr) {
                      inFlightValueRef.current = null;
                    }
                    if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
                      console.warn(`Firestore Quota Exceeded for ${key}. Updates will stay local until reset.`);
                      handleGlobalQuotaTrigger();
                    } else if (err.code === 'permission-denied' || err.message?.toLowerCase().includes('permission')) {
                      handleFirestoreError(err, OperationType.WRITE, 'sync/' + key);
                    } else {
                      console.error(`Error syncing key ${key} to Firestore:`, err);
                    }
                  });
              }
            }
          };

          // Optimized 50ms delay for ultra-fast, near-instant propagation
          timeoutRef.current = setTimeout(syncToFirestore, 50);
        }
      }
      return newValue;
    });
  }, [key]);

  return [state, setSyncedState] as const;
}

// Mock Initial Data
const INITIAL_RINGS: RingStatus[] = Array.from({ length: 12 }, (_, i) => ({
  ringNumber: i + 1,
  currentBout: null,
  onDeck: null,
  inTheHole: null
}));

interface UserAccount {
  username: string;
  password: string;
  role: 'admin' | 'user' | 'viewer' | 'ta' | 'report';
  assignedRing?: number;
}

interface BoutTransferBroadcast {
  id: string;
  fromRing: string;
  toRing: string;
  boutNumber: string;
  timestamp: any;
  pinnedUntil: string;
  isPinned: boolean;
  author?: string;
}

function PinnedTransferBanner({ transfers, isAdmin, onDelete }: { 
  transfers: BoutTransferBroadcast[], 
  isAdmin: boolean,
  onDelete: (id: string) => void 
}) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const activeTransfers = transfers.filter(t => {
    if (!t.isPinned) return false;
    const expiry = new Date(t.pinnedUntil);
    return expiry > now;
  });

  if (activeTransfers.length === 0) return null;

  return (
    <div className="w-full grid grid-cols-1 lg:grid-cols-2 gap-3 px-8 pt-4 pb-2 shrink-0 transition-all">
      {activeTransfers.map((t) => {
        const expiry = new Date(t.pinnedUntil);
        const diffMs = expiry.getTime() - now.getTime();
        const diffMin = Math.max(0, Math.floor(diffMs / 60000));
        const diffSec = Math.max(0, Math.floor((diffMs % 60000) / 1000));
        const isSingle = activeTransfers.length === 1;
        
        return (
          <div 
            key={t.id} 
            className={`bg-yellow-500 text-slate-950 border-4 border-yellow-400 rounded-3xl p-5 md:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-[0_10px_30px_rgba(234,179,8,0.25)] relative ${isSingle ? "lg:col-span-2" : ""}`}
          >
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-slate-950 text-yellow-500 rounded-2xl flex items-center justify-center font-black shrink-0">
                <Bell size={24} className="animate-bounce" />
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] font-black uppercase tracking-[0.25em] text-slate-800 leading-none">
                  Announcement Bout Transfer
                </span>
                <span className="text-lg md:text-2xl font-black uppercase tracking-tight text-slate-950 mt-1">
                  Ring {t.fromRing} ➡️ Ring {t.toRing} - Bout {t.boutNumber}
                </span>
              </div>
            </div>
            
            <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end shrink-0">
              {isAdmin && (
                <button
                  onClick={() => onDelete(t.id)}
                  className="p-3 bg-red-650 hover:bg-red-700 bg-red-600 text-white rounded-2xl transition-all font-black uppercase text-[10px] tracking-widest flex items-center gap-1.5 shadow shadow-red-900/20 active:scale-95 cursor-pointer"
                  title="Cancel and Delete Pin"
                >
                  <X size={14} />
                  <span>Cancel Pin</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AnnouncementPopup({ announcement, onClose, size = 'normal' }: { announcement: { message: string, id: string } | null, onClose: () => void, size?: 'normal' | 'large' }) {
  const isLarge = size === 'large';
  return (
    <AnimatePresence>
      {announcement && (
        <motion.div
          initial={{ opacity: 0, x: "-50%", y: "-40%", scale: 0.9 }}
          animate={{ opacity: 1, x: "-50%", y: "-50%", scale: 1 }}
          exit={{ opacity: 0, x: "-50%", y: "-40%", scale: 0.9 }}
          className={cn(
            "fixed top-1/2 left-1/2 z-[100] w-full px-4",
            isLarge ? "max-w-6xl" : "max-w-2xl"
          )}
        >
          <div className="bg-slate-900 border-4 border-red-600 rounded-[2rem] shadow-[0_20px_50px_rgba(220,38,38,0.3)] overflow-hidden">
            <div className={cn("bg-red-600 flex items-center justify-between", isLarge ? "px-10 py-5" : "px-8 py-3")}>
              <div className="flex items-center gap-3">
                <Bell size={isLarge ? 32 : 20} className="text-white animate-bounce" />
                <span className={cn("font-black text-white uppercase tracking-[0.2em]", isLarge ? "text-xl" : "text-sm")}>Official Announcement</span>
              </div>
              <button 
                onClick={onClose}
                className="p-1 hover:bg-white/20 rounded-lg text-white transition-colors"
              >
                <X size={isLarge ? 32 : 20} />
              </button>
            </div>
            <div className={cn("text-center", isLarge ? "p-16" : "p-8")}>
              <p className={cn("font-black text-white leading-tight tracking-tight", isLarge ? "text-5xl" : "text-2xl")}>
                {announcement.message}
              </p>
              <div className={cn("flex items-center justify-center gap-2", isLarge ? "mt-10" : "mt-6")}>
                <div className={cn("bg-red-600/30 rounded-full overflow-hidden", isLarge ? "h-2 w-24" : "h-1 w-12")}>
                  <motion.div 
                    initial={{ width: "100%" }}
                    animate={{ width: "0%" }}
                    transition={{ duration: 60, ease: "linear" }}
                    className="h-full bg-red-600"
                  />
                </div>
                <span className={cn("font-bold text-slate-500 uppercase tracking-widest", isLarge ? "text-sm" : "text-[10px]")}>Closing in 1m</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

import { EditBoutDetailsModal } from './components/EditBoutDetailsModal';

export default function App() {
  const [events, setEvents] = useSyncedState<EventData[]>('tkd_events_v3', []);
  const [currentEventId, setCurrentEventId] = useSyncedState<string | null>('tkd_current_event_v3', null);

  const isStrictPublic = typeof import.meta !== 'undefined' && import.meta.env && (
    import.meta.env.VITE_APP_MODE === 'PUBLIC' || 
    (typeof window !== 'undefined' && 
     !new URLSearchParams(window.location.search).has('login') && 
     !new URLSearchParams(window.location.search).has('manage') && 
     !new URLSearchParams(window.location.search).has('operator') && 
     !localStorage.getItem('tkd_user'))
  );

  const [user, setUser] = useState<UserAccount | null>(() => {
    if (isStrictPublic) {
      return null;
    }
    const saved = localStorage.getItem('tkd_user');
    const loginTime = localStorage.getItem('tkd_login_time');
    
    if (saved && loginTime) {
      const now = new Date().getTime();
      const loginTs = parseInt(loginTime);
      const twoWeeks = 14 * 24 * 60 * 60 * 1000;
      
      if (now - loginTs > twoWeeks) {
        localStorage.removeItem('tkd_user');
        localStorage.removeItem('tkd_login_time');
        return null;
      }
      return JSON.parse(saved);
    }
    return null;
  });
  const [accounts, setAccounts] = useSyncedState<UserAccount[]>('tkd_accounts', (() => {
    let parsed: UserAccount[] = [
      { username: 'admin', password: 'lee093', role: 'admin' }
    ];
    for (let i = 1; i <= 12; i++) {
      parsed.push({
        username: `ring${i}`,
        password: '123',
        role: 'user',
        assignedRing: i
      });
    }
    parsed.push({ username: 'viewer', password: '123', role: 'viewer' });
    parsed.push({ username: 'TA', password: '123', role: 'ta' });
    parsed.push({ username: 'report', password: '123', role: 'report' });
    return parsed;
  })());

  const [rings, setRings] = useSyncedState<RingStatus[]>('tkd_rings', INITIAL_RINGS);
  const [autoPullRings, setAutoPullRings] = useSyncedState<Record<number, boolean>>('tkd_autopull', {});
  const [isAutoUpdateNames, setIsAutoUpdateNames] = useSyncedState<boolean>('tkd_auto_update_names', true);
  const [boutQueue, setBoutQueue] = useSyncedState<{id: string, data: MatchData}[]>('tkd_bout_queue', []);
  const [matchHistory, setMatchHistory] = useState<MatchHistoryItem[]>([]);
  
  // Track the absolute newest data to avoid stale closures in event listeners
  const latestDataRef = useRef({
    matchHistory,
    currentEventId,
    events
  });
  useEffect(() => {
    latestDataRef.current = {
      matchHistory,
      currentEventId,
      events
    };
  }, [matchHistory, currentEventId, events]);
  const [mappings, setMappings] = useState<BoutMapping[]>([]);
  const [athletes, setAthletes] = useState([
    { name: "Ahmad bin Ibrahim", ic: "080512-14-5567", club: "KST", category: "Junior Male -45kg", status: "Verified" as const },
    { name: "Lim Wei Kang", ic: "091122-08-1234", club: "TKT", category: "Junior Male -45kg", status: "Pending" as const },
    { name: "Siti Nurhaliza", ic: "100101-10-9876", club: "PST", category: "Junior Female -42kg", status: "Verified" as const },
  ]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeAnnouncement, setActiveAnnouncement] = useState<{ message: string, id: string } | null>(null);
  const [showAnnouncementInput, setShowAnnouncementInput] = useState(false);
  const [announcementText, setAnnouncementText] = useState('');
  const [announcementTarget, setAnnouncementTarget] = useState<'all' | 'users'>('all');
  const [broadcastModalType, setBroadcastModalType] = useState<'standard' | 'transfer'>('standard');
  const [transferFromRing, setTransferFromRing] = useState('');
  const [transferToRing, setTransferToRing] = useState('');
  const [transferBoutNumber, setTransferBoutNumber] = useState('');
  const [boutTransfers, setBoutTransfers] = useState<BoutTransferBroadcast[]>([]);
  const [dashboardSelectedRing, setDashboardSelectedRing] = useState<number>(() => {
    try {
      const savedUser = localStorage.getItem('tkd_user');
      if (savedUser) {
        const parsed = JSON.parse(savedUser);
        if (parsed?.assignedRing) return Number(parsed.assignedRing);
      }
    } catch (e) {}
    return 1;
  });

  useEffect(() => {
    if (user?.assignedRing) {
      setDashboardSelectedRing(Number(user.assignedRing));
    }
  }, [user]);

  useEffect(() => {
    if (!currentEventId || isFirestoreQuotaExceeded) return;
    const q = query(collection(db, 'event_logic'), where('eventId', '==', currentEventId));
    let unsub = () => {};
    
    const handleGlobalQuota = () => {
      unsub();
    };
    window.addEventListener('firestore-quota-exceeded', handleGlobalQuota);

    if (isFirestoreQuotaExceeded) return;
    try {
      unsub = onSnapshot(q, (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BoutMapping));
        console.log('Mappings updated:', data.length);
        setMappings(data);
      }, (error) => {
        if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
          handleGlobalQuotaTrigger();
          unsub();
        } else if (error.code !== 'permission-denied') {
          console.error("Firestore Mappings Error:", error);
        }
      });
    } catch (e: any) {
      if (e.code === 'resource-exhausted' || e.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }

    return () => {
      unsub();
      window.removeEventListener('firestore-quota-exceeded', handleGlobalQuota);
    };
  }, [currentEventId]);

  useEffect(() => {
    if (!currentEventId || isFirestoreQuotaExceeded) return;
    const q = query(collection(db, 'matchHistory'), where('eventId', '==', currentEventId));
    let unsub = () => {};

    const handleGlobalQuota = () => {
      unsub();
    };
    window.addEventListener('firestore-quota-exceeded', handleGlobalQuota);

    if (isFirestoreQuotaExceeded) return;
    try {
      unsub = onSnapshot(q, (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
        // Replace entire history with collection state to stay in sync with Firestore source of truth
        setMatchHistory(data);
      }, (error) => {
        if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
          handleGlobalQuotaTrigger();
          unsub();
        } else if (error.code !== 'permission-denied') {
          console.error("Firestore History Error:", error);
        }
      });
    } catch (e: any) {
      if (e.code === 'resource-exhausted' || e.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }

    return () => {
      unsub();
      window.removeEventListener('firestore-quota-exceeded', handleGlobalQuota);
    };
  }, [currentEventId]);

  // Automated queue pruning to prevent completed bouts from lingering in the queue
  useEffect(() => {
    if (!currentEventId || boutQueue.length === 0 || matchHistory.length === 0) return;
    
    // Only run if the user has write clearance (is authorized) to write state changes to cloud
    const savedUser = localStorage.getItem('tkd_user');
    let canWrite = false;
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        canWrite = ['admin', 'user', 'ta'].includes(parsed?.role);
      } catch (_) {}
    }
    if (!canWrite) return;

    const completedBoutIds = new Set(
      matchHistory
        .filter(h => h.eventId === currentEventId && h.winner && h.winner !== '-' && h.winner.trim() !== '')
        .map(h => normalizeBoutNumber(h.bout))
    );

    if (completedBoutIds.size === 0) return;

    const remainingBouts = boutQueue.filter(item => {
      // Do NOT filter out custom "restored_" entries if they are meant to be replayed
      if (item.id.startsWith('restored_')) return true;
      
      const boutNumNorm = normalizeBoutNumber(item.data.bout);
      return !completedBoutIds.has(boutNumNorm);
    });

    if (remainingBouts.length !== boutQueue.length) {
      console.log(`Auto-cleaned ${boutQueue.length - remainingBouts.length} completed bouts from boutQueue.`);
      setBoutQueue(remainingBouts);
      localStorage.setItem('tkd_bout_queue', JSON.stringify(remainingBouts));
    }
  }, [matchHistory, currentEventId, boutQueue, setBoutQueue]);


  useEffect(() => {
    const handleSyncHistory = (e: any) => {
      const newHistory = e.detail;
      setMatchHistory(prev => {
        let updated = [...prev];
        newHistory.forEach((item: any) => {
          const index = updated.findIndex(h => h.id === item.id);
          if (index !== -1) {
            updated[index] = item;
          } else {
            updated.push(item);
          }
        });
        return updated;
      });
    };
    
    const handleForcePropagate = (e?: any, isSilent = false) => {
      if (!isSilent) console.log('Force propagating winners triggered');
      const sheetMatches: any[] = e?.detail || [];
      
      // We will manually scan match history and update boutQueue and rings immediately.
      let ringsUpdated = false;
      let queueUpdated = false;
      
      const processBout = (bout: MatchData) => {
        if (bout.isManuallyEdited) return false;
        let updated = false;
        
        const { matchHistory, currentEventId, events } = latestDataRef.current;
        const currentEvt = events.find(e => e.id === currentEventId);
        const currentEvtName = (currentEvt ? currentEvt.name : '').trim().toLowerCase();

        const normalizeStr = (s: string | null | undefined) => s ? s.toLowerCase().replace(/[^a-z0-9]/g, '').trim() : '';

        // 1. Try to fulfill "WINNER OF X" placeholders using matchHistory
        const blueBoutId = extractWinnerOfBout(bout.blue_name);
        if (blueBoutId) {
          let historyMatch = matchHistory.find((h: MatchHistoryItem) => 
            isBoutMatch(h.bout, blueBoutId) && 
            h.eventId === currentEventId &&
            normalizeStr(h.category) === normalizeStr(bout.category)
          );
          if (!historyMatch) {
            historyMatch = matchHistory.find((h: MatchHistoryItem) => 
              isBoutMatch(h.bout, blueBoutId) && 
              h.eventId === currentEventId
            );
          }
          if (historyMatch && historyMatch.winner && historyMatch.winner !== '-' && historyMatch.winner.trim() !== '') {
            bout.blue_name = historyMatch.winner.toUpperCase();
            if (historyMatch.winnerClub) bout.blue_club = historyMatch.winnerClub.toUpperCase();
            updated = true;
          }
        }
        
        const redBoutId = extractWinnerOfBout(bout.red_name);
        if (redBoutId) {
          let historyMatch = matchHistory.find((h: MatchHistoryItem) => 
            isBoutMatch(h.bout, redBoutId) && 
            h.eventId === currentEventId &&
            normalizeStr(h.category) === normalizeStr(bout.category)
          );
          if (!historyMatch) {
            historyMatch = matchHistory.find((h: MatchHistoryItem) => 
              isBoutMatch(h.bout, redBoutId) && 
              h.eventId === currentEventId
            );
          }
          if (historyMatch && historyMatch.winner && historyMatch.winner !== '-' && historyMatch.winner.trim() !== '') {
            bout.red_name = historyMatch.winner.toUpperCase();
            if (historyMatch.winnerClub) bout.red_club = historyMatch.winnerClub.toUpperCase();
            updated = true;
          }
        }

        // 2. Override with direct player names from the Google Sheet if available
        const sheetM = sheetMatches.find(sm => {
          const matchesBout = isBoutMatch(sm.matchNo, bout.bout);
          const matchesRing = String(sm.ringNo) === String(bout.ring);
          const smEventName = sm.eventName ? sm.eventName.trim().toLowerCase() : '';
          const matchesEvent = currentEvtName ? smEventName === currentEvtName : true;
          return matchesBout && matchesRing && matchesEvent;
        });
        if (sheetM) {
          if (sheetM.blueName && sheetM.blueName !== '-' && !/WINNER(?: OF)?\s+/i.test(sheetM.blueName)) {
            if (bout.blue_name?.toUpperCase() !== sheetM.blueName.toUpperCase()) {
              bout.blue_name = sheetM.blueName.toUpperCase();
              if (sheetM.blueClub) bout.blue_club = sheetM.blueClub.toUpperCase();
              updated = true;
            }
          }
          if (sheetM.redName && sheetM.redName !== '-' && !/WINNER(?: OF)?\s+/i.test(sheetM.redName)) {
            if (bout.red_name?.toUpperCase() !== sheetM.redName.toUpperCase()) {
              bout.red_name = sheetM.redName.toUpperCase();
              if (sheetM.redClub) bout.red_club = sheetM.redClub.toUpperCase();
              updated = true;
            }
          }
        }

        return updated;
      };

      setRings(prevRings => {
        let newRings = [...prevRings];
        newRings = newRings.map(ring => {
          let ringChanged = false;
          let r = { ...ring };
          ['currentBout', 'onDeck', 'inTheHole'].forEach(slot => {
            if (r[slot as keyof typeof r]) {
              const bout = { ...(r[slot as keyof typeof r] as MatchData) };
              if (processBout(bout)) {
                (r as any)[slot] = bout;
                ringChanged = true;
              }
            }
          });
          if (ringChanged) ringsUpdated = true;
          return r;
        });
        return ringsUpdated ? newRings : prevRings;
      });

      setBoutQueue(prevQueue => {
        let newQueue = [...prevQueue];
        newQueue = newQueue.map(item => {
          let bout = { ...item.data };
          if (processBout(bout)) {
            queueUpdated = true;
            return { ...item, data: bout };
          }
          return item;
        });
        return queueUpdated ? newQueue : prevQueue;
      });
      
      // Also trigger a match history replace to poke the effect
      if (ringsUpdated || queueUpdated) {
        setMatchHistory(prev => [...prev]);
        if (!isSilent) console.log('Force propagate complete.');
      }
    };

    window.addEventListener('tkd_sync_history', handleSyncHistory);
    window.addEventListener('tkd_force_propagate_winners', handleForcePropagate);
    
    // Auto-run force propagate if enabled
    let autoPropagateInterval: number | undefined;
    if (isAutoUpdateNames) {
      autoPropagateInterval = window.setInterval(() => {
        // Don't log on auto-run to avoid spamming console
        handleForcePropagate(null, true); 
      }, 300000); // 5 minutes
    }

    return () => {
      window.removeEventListener('tkd_sync_history', handleSyncHistory);
      window.removeEventListener('tkd_force_propagate_winners', handleForcePropagate);
      if (autoPropagateInterval) clearInterval(autoPropagateInterval);
    }
  }, [setMatchHistory, isAutoUpdateNames]);

  // 3. Mandatory Multi-Device Network Throttling
  // Since 12 devices are querying data simultaneously, implement randomized polling jitter to prevent server crashing.
  useEffect(() => {
    const syncDashboardWithServer = () => {
      // Background synchronization loop logic
      window.dispatchEvent(new CustomEvent('tkd_force_propagate_winners'));
    };

    // Example exactly as requested: setInterval(syncDashboardWithServer, 3000 + Math.random() * 1000);
    const intervalId = setInterval(syncDashboardWithServer, 3000 + Math.random() * 1000);

    return () => clearInterval(intervalId);
  }, []);

  // Ensure TA and report accounts exist for returning users
  useEffect(() => {
    let changed = false;
    let newAccounts = [...accounts];
    if (accounts.length > 0 && !accounts.some(a => a.username === 'TA')) {
      newAccounts.push({ username: 'TA', password: '123', role: 'ta' });
      changed = true;
    }
    if (accounts.length > 0 && !accounts.some(a => a.username === 'report')) {
      newAccounts.push({ username: 'report', password: '123', role: 'report' });
      changed = true;
    }
    if (changed) setAccounts(newAccounts);
  }, [accounts, setAccounts]);

  // Auto-logout check interval
  useEffect(() => {
    if (!user) return;

    const checkTimeout = () => {
      const loginTime = localStorage.getItem('tkd_login_time');
      if (loginTime) {
        const now = new Date().getTime();
        const loginTs = parseInt(loginTime);
        const twoWeeks = 14 * 24 * 60 * 60 * 1000;
        
        if (now - loginTs > twoWeeks) {
          handleLogout();
        }
      }
    };

    const interval = setInterval(checkTimeout, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [user]);

  useEffect(() => {
    if (isFirestoreQuotaExceeded) return;
    const q = query(collection(db, 'announcements'), orderBy('timestamp', 'desc'), limit(1));
    let unsubscribe = () => {};

    const handleGlobalQuota = () => {
      unsubscribe();
    };
    window.addEventListener('firestore-quota-exceeded', handleGlobalQuota);

    if (isFirestoreQuotaExceeded) return;
    try {
      unsubscribe = onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
          const data = snapshot.docs[0].data();
          const id = snapshot.docs[0].id;
          
          const target = data.target || 'all';
          if (target === 'users' && user?.role !== 'user') return;
          
          // Check if it's too old (more than 12 hours)
          if (data.timestamp) {
            const ts = data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
            const now = new Date();
            if (now.getTime() - ts.getTime() > 12 * 60 * 60 * 1000) return;
          }

          const lastSeen = localStorage.getItem('tkd_last_announcement');
          const isDismissed = localStorage.getItem(`tkd_announcement_dismissed_${id}`);
          
          if (lastSeen !== id && !isDismissed) {
            setActiveAnnouncement({ message: data.message, id });
            localStorage.setItem('tkd_last_announcement', id);
            
            const timer = setTimeout(() => {
              setActiveAnnouncement(null);
            }, 60000);
            return () => clearTimeout(timer);
          }
        }
      }, (error) => {
        if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
          handleGlobalQuotaTrigger();
          unsubscribe();
        } else if (error.code !== 'permission-denied') {
          console.error("Firestore Announcements Error:", error);
        }
      });
    } catch (e: any) {
      if (e.code === 'resource-exhausted' || e.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }

    return () => {
      unsubscribe();
      window.removeEventListener('firestore-quota-exceeded', handleGlobalQuota);
    };
  }, [user?.role]);

  useEffect(() => {
    if (isFirestoreQuotaExceeded) return;
    const q = query(collection(db, 'bout_transfers'), orderBy('timestamp', 'desc'));
    let unsubscribe = () => {};

    try {
      unsubscribe = onSnapshot(q, (snapshot) => {
        const list = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        } as BoutTransferBroadcast));
        setBoutTransfers(list);
      }, (error) => {
        if (error.code !== 'permission-denied') {
          console.error("Firestore Bout Transfers Error:", error);
        }
      });
    } catch (e) {
      console.error("Error setting up bout transfers listener:", e);
    }

    return () => unsubscribe();
  }, []);

  const handleSendTransferBroadcast = async () => {
    if (!transferFromRing || !transferToRing || !transferBoutNumber) return;
    if (isFirestoreQuotaExceeded) {
      console.warn("Firestore quota exceeded, cannot send transfer announcement.");
      return;
    }
    
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes later
      
      await addDoc(collection(db, 'bout_transfers'), {
        fromRing: transferFromRing.trim(),
        toRing: transferToRing.trim(),
        boutNumber: transferBoutNumber.trim().toUpperCase(),
        timestamp: serverTimestamp(),
        pinnedUntil: expiresAt.toISOString(),
        isPinned: true,
        author: user?.username || 'Admin'
      });
      
      setTransferFromRing('');
      setTransferToRing('');
      setTransferBoutNumber('');
      setShowAnnouncementInput(false);
      setBroadcastModalType('standard');
    } catch (error: any) {
      console.error("Error sending transfer broadcast:", error);
      if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }
  };

  const handleCancelTransferPin = async (id: string) => {
    if (isFirestoreQuotaExceeded) return;
    try {
      await deleteDoc(doc(db, 'bout_transfers', id));
    } catch (error: any) {
      console.error("Error deleting transfer broadcast:", error);
    }
  };

  const handleAnnouncementClose = () => {
    if (activeAnnouncement) {
      localStorage.setItem(`tkd_announcement_dismissed_${activeAnnouncement.id}`, 'true');
    }
    setActiveAnnouncement(null);
  };

  const handleSendAnnouncement = async () => {
    if (!announcementText.trim()) return;
    if (isFirestoreQuotaExceeded) {
      console.warn("Firestore quota exceeded, cannot send announcement.");
      return;
    }
    try {
      await addDoc(collection(db, 'announcements'), {
        message: announcementText,
        timestamp: serverTimestamp(),
        author: user?.username || 'Admin',
        target: announcementTarget
      });
      setAnnouncementText('');
      setShowAnnouncementInput(false);
    } catch (error: any) {
      console.error("Error sending announcement:", error);
      if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }
  };
  const [activeTab, setActiveTab] = useState<string>(() => {
    const savedUser = localStorage.getItem('tkd_user');
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser);
        if (parsed.role === 'viewer') return 'general';
        if (parsed.role === 'user') return 'mats';
        if (parsed.role === 'report') return 'report';
        if (parsed.role === 'ta') return 'ta-sheet';
      } catch (e) {
        // ignore
      }
    }
    return 'dashboard';
  });
  const [isImportingBouts, setIsImportingBouts] = useState(false);
  const [isPublicView, setIsPublicView] = useState(() => {
    // Check environment variable or URL parameter
    const isPublicEnv = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_APP_MODE === 'PUBLIC';
    const isPublicUrl = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'public';
    return isPublicEnv || isPublicUrl;
  });
  const [showLogin, setShowLogin] = useState(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.has('login') || params.has('manage') || params.has('operator');
    }
    return false;
  });
  const [showNewBoutModal, setShowNewBoutModal] = useState(false);
  const [newBoutInitialRing, setNewBoutInitialRing] = useState<number | undefined>(undefined);
  const [showEditResultModal, setShowEditResultModal] = useState(false);
  const [showEditBoutDetailsModal, setShowEditBoutDetailsModal] = useState(false);
  const [showAddRingModal, setShowAddRingModal] = useState(false);
  const [missingBoutPrompt, setMissingBoutPrompt] = useState<{ ringNumber: number; expectedBout: number; totalBouts: number } | null>(null);
  const [finalBoutCheck, setFinalBoutCheck] = useState<{ ringNumber: number; remainingCount: number } | null>(null);
  const [ringNamingMode, setRingNamingMode] = useSyncedState<'number' | 'alphabet'>('tkd_ring_naming_mode', 'number');
  const [boutNumberingMode, setBoutNumberingMode] = useSyncedState<'numeric' | 'alphanumeric'>('tkd_bout_numbering_mode', 'alphanumeric');
  const [categories, setCategories] = useSyncedState<string[]>('tkd_categories', ["Junior Male -45kg", "Junior Female -42kg", "Senior Male -54kg", "INDIVIDUAL POOMSAE"]);
  const [clubs, setClubs] = useSyncedState<string[]>('tkd_clubs', ["KST", "TKT", "PST", "MTA"]);
  const [googleSheetUrl, setGoogleSheetUrl] = useSyncedState<string>('tkd_sheet_url', 'https://script.google.com/macros/s/AKfycbxG7SG0HB8WPom3-Pknpjy0Da2bupLF4s7cmqhRci-gosmcATjZubldik7kacnlLoIq/exec');
  const [localSheetUrl, setLocalSheetUrl] = useState(googleSheetUrl);
  useEffect(() => {
    setLocalSheetUrl(googleSheetUrl);
  }, [googleSheetUrl]);
  useEffect(() => {
    // Automatically migrate existing clients with the old default URL in their local storage to the new default URL
    if (googleSheetUrl === 'https://script.google.com/macros/s/AKfycbykWTnkJwZ649ntvetGSL793ZNFPJE9yhjnNpTWpoS8NmVPjMDGp2PAb12dWK8KWLfm/exec') {
      setGoogleSheetUrl('https://script.google.com/macros/s/AKfycbxG7SG0HB8WPom3-Pknpjy0Da2bupLF4s7cmqhRci-gosmcATjZubldik7kacnlLoIq/exec');
    }
  }, [googleSheetUrl, setGoogleSheetUrl]);
  const [isSheetSaved, setIsSheetSaved] = useState(false);

  const getActiveSyncUrl = (passedUrl?: string) => {
    const event = currentEventId ? events.find(e => e.id === currentEventId) : null;
    return getEventWebAppUrl(event || undefined, passedUrl || googleSheetUrl);
  };

  const syncToGoogleSheets = (url: string, data: MatchData, eventName: string = '', reason: string = '') => {
    return rawSyncToGoogleSheets(getActiveSyncUrl(url), data, eventName, reason);
  };

  const updateWinnerInGoogleSheets = (url: string, ring: number, bout: string | number, winner: string, eventName: string = '', winnerSide?: string, blueName?: string, redName?: string, points?: any, winnerClub?: string, blueClub?: string, redClub?: string) => {
    return rawUpdateWinnerInGoogleSheets(getActiveSyncUrl(url), ring, bout, winner, eventName, winnerSide, blueName, redName, points, winnerClub, blueClub, redClub);
  };

  const updateBoutDetailsInGoogleSheets = (url: string, ring: number, bout: string | number, blueName: string, blueClub: string, redName: string, redClub: string, eventName: string = '') => {
    return rawUpdateBoutDetailsInGoogleSheets(getActiveSyncUrl(url), ring, bout, blueName, blueClub, redName, redClub, eventName);
  };

  const updatePointsInGoogleSheets = (url: string, ring: number, bout: string | number, points: any, eventName: string = '') => {
    return rawUpdatePointsInGoogleSheets(getActiveSyncUrl(url), ring, bout, points, eventName);
  };
  const [showTotalBoutsPublic, setShowTotalBoutsPublic] = useSyncedState<boolean>('tkd_show_total_bouts_public', true);
  const [showOnlyActiveRings, setShowOnlyActiveRings] = useSyncedState<boolean>('tkd_show_only_active_rings', false);
  const [showEmptyBoutAsInactive, setShowEmptyBoutAsInactive] = useSyncedState<boolean>('tkd_show_empty_bout_inactive', false);
  const [ringControlLayout, setRingControlLayout] = useSyncedState<'winner' | 'point'>('tkd_ring_control_layout', 'winner');
  const [publicViewLayout, setPublicViewLayout] = useSyncedState<'standard' | 'point'>('tkd_public_view_layout', 'standard');
  const [showPublicStandbyQueue, setShowPublicStandbyQueue] = useSyncedState<boolean>('tkd_show_public_standby_queue', true);
  const [showInspectionPopupSetting, setShowInspectionPopupSetting] = useSyncedState<boolean>('tkd_show_inspection_popup_setting', true);
  const [confirmResultSubmission, setConfirmResultSubmission] = useSyncedState<boolean>('tkd_confirm_result_submission', false);
  const [pendingWinnerSelection, setPendingWinnerSelection] = useState<{ ringNumber: number; boutNumber: string | number; winner: string } | null>(null);
  const [publicEventId, setPublicEventId] = useSyncedState<string>('tkd_public_event_id', 'active');
  const [visibleRingsCount, setVisibleRingsCount] = useSyncedState<number>('tkd_visible_rings_count', 12);
  const [slideInterval, setSlideInterval] = useSyncedState<number>('tkd_slide_interval', 15);
  const [backupData, setBackupData] = useSyncedState<Record<string, { mappings: BoutMapping[], matches: MatchData[] }>>('tkd_backup_data_v3', {});
  const [backupToLoad, setBackupToLoad] = useState<{ mappings: Partial<BoutMapping>[], matches: MatchData[] } | null>(null);
  const [isQuotaExceeded, setIsQuotaExceeded] = useState(false);
  const [showRebootModal, setShowRebootModal] = useState(false);

  useEffect(() => {
    const handleQuotaExceeded = () => {
      setIsQuotaExceeded(true);
      disableFirestoreNetwork();
    };
    const handleRequestReboot = () => {
      setShowRebootModal(true);
    };
    window.addEventListener('firestore-quota-exceeded', handleQuotaExceeded);
    window.addEventListener('request-reboot', handleRequestReboot);
    return () => {
      window.removeEventListener('firestore-quota-exceeded', handleQuotaExceeded);
      window.removeEventListener('request-reboot', handleRequestReboot);
    };
  }, []);

  const handleConfirmReboot = () => {
    localStorage.removeItem('tkd_disable_firebase');
    isFirestoreQuotaExceeded = false;
    window.location.reload();
  };

  const handleCancelReboot = () => {
    setShowRebootModal(false);
  };

  // Auto-select first event when currentEventId is null or not valid
  useEffect(() => {
    if (events.length > 0) {
      if (!currentEventId || !events.some(e => e.id === currentEventId)) {
        const defaultEventId = events[0].id;
        setCurrentEventId(defaultEventId);
        localStorage.setItem('tkd_current_event_v3', defaultEventId);
        
        const event = events.find(e => e.id === defaultEventId);
        if (event) {
          const webAppUrl = getEventWebAppUrl(event, googleSheetUrl);
          setGoogleSheetUrl(webAppUrl);
          localStorage.setItem('tkd_sheet_url', webAppUrl);
        }
        console.log("Automatically synchronized and activated default event:", defaultEventId);
      }
    }
  }, [events, currentEventId, setCurrentEventId, setGoogleSheetUrl]);

  // Persistence & Cross-tab Sync handled by useSyncedState

  const getRingName = (num: number) => {
    if (ringNamingMode === 'number') return num.toString();
    return String.fromCharCode(64 + num); // 1 -> A, 2 -> B, etc.
  };

  const getCurrentEventName = () => {
    if (!currentEventId) return '-';
    const event = events.find(e => e.id === currentEventId);
    return event ? event.name : '-';
  };

  const getCurrentEventDate = () => {
    if (!currentEventId) return '';
    const event = events.find(e => e.id === currentEventId);
    return event ? event.eventDate : '';
  };

  const formatTime = (date: Date | string) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getFilteredQueue = (ringNum?: number) => {
    const completedBoutIds = new Set(
      matchHistory
        .filter(h => h.eventId === currentEventId && h.winner && h.winner !== '-' && h.winner.trim() !== '')
        .map(h => normalizeBoutNumber(h.bout))
    );

    return boutQueue
      .filter(item => {
        const matchesEvent = !item.data.eventId || item.data.eventId === currentEventId;
        const itemRing = Number(item.data.ring);
        const matchesRing = ringNum === undefined || itemRing === Number(ringNum);
        const matchesUserRing = user?.role === 'admin' || itemRing === Number(user?.assignedRing);
        const isCompleted = completedBoutIds.has(normalizeBoutNumber(item.data.bout));
        return matchesEvent && matchesRing && matchesUserRing && !isCompleted;
      })
      .sort((a, b) => {
        const parseBout = (bout: string | number) => {
          let s = bout.toString().replace(/\s+/g, '').toUpperCase();
          s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
          if (/^[A-Z]/.test(s)) return s;
          const parsed = parseInt(s.replace(/[^0-9]/g, ''));
          return isNaN(parsed) ? s : parsed;
        };

        const valA = parseBout(a.data.bout);
        const valB = parseBout(b.data.bout);

        if (typeof valA === 'number' && typeof valB === 'number') {
          if (valA !== valB) return valA - valB;
        } else if (typeof valA === 'string' && typeof valB === 'string') {
          if (valA !== valB) return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        } else if (typeof valA === 'number') {
          return -1;
        } else {
          return 1;
        }
        
        // Fallback to stable string comparison and ID-based tiebreaker
        const strA = (a.data.bout || '').toString();
        const strB = (b.data.bout || '').toString();
        
        // Exact identical IDs should not jump
        if (a.id === b.id) return 0;
        
        const strCmp = strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
        if (strCmp !== 0) return strCmp;
        return a.id.localeCompare(b.id);
      });
  };

  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [syncLog, setSyncLog] = useState<{timestamp: Date, action: string, status: 'success' | 'error', message: string}[]>([]);

  const addToSyncLog = (action: string, status: 'success' | 'error', message: string) => {
    setSyncLog(prev => [{ timestamp: new Date(), action, status, message }, ...prev].slice(0, 50));
  };

  const lastLoadedEventIdRef = useRef<string | null>(null);

  // Sync googleSheetUrl with current event when switching events
  useEffect(() => {
    if (currentEventId && events.length > 0) {
      if (lastLoadedEventIdRef.current !== currentEventId) {
        const event = events.find(e => e.id === currentEventId);
        if (event) {
          console.log("Loading Google Sheet URL for newly selected event:", event.name);
          const webAppUrl = getEventWebAppUrl(event, googleSheetUrl);
          setGoogleSheetUrl(webAppUrl);
          lastLoadedEventIdRef.current = currentEventId;
        }
      }
    } else {
      lastLoadedEventIdRef.current = null;
    }
  }, [currentEventId, events, setGoogleSheetUrl, googleSheetUrl]);

  const handleNewBoutSubmit = async (ringNumber: number, newData: MatchData) => {
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNumber);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    console.log("Creating new bout:", newData);
    
    // Capitalize all letters
    const capitalizedData: MatchData = {
      ...newData,
      blue_name: newData.blue_name?.toUpperCase() || '',
      blue_club: newData.blue_club?.toUpperCase() || '',
      red_name: newData.red_name?.toUpperCase() || '',
      red_club: newData.red_club?.toUpperCase() || '',
      category: newData.category?.toUpperCase() || '',
      bout: newData.bout?.toString().toUpperCase() || '',
      allowCompleted: true,
    };

    // Update categories and clubs lists
    if (capitalizedData.category && !categories.includes(capitalizedData.category)) {
      setCategories(prev => [...prev, capitalizedData.category]);
    }
    if (capitalizedData.blue_club && !clubs.includes(capitalizedData.blue_club)) {
      setClubs(prev => [...prev, capitalizedData.blue_club]);
    }
    if (capitalizedData.red_club && !clubs.includes(capitalizedData.red_club)) {
      setClubs(prev => [...prev, capitalizedData.red_club]);
    }

    // Add to queue
    const queueItem = { id: Math.random().toString(36).substr(2, 9), data: { ...capitalizedData, eventId: currentEventId || null } };
    setBoutQueue(prev => [...prev, queueItem]);

    // Note: We removed the direct sync to Google Sheets from here to prevent duplicate entries.
    // The bout will be synced to Google Sheets when it is pulled to a ring via handleBoutUpdate.
    console.log("Bout added to queue. It will sync to Google Sheets when pulled to a ring.");
  };

  const handleCreateManualInspectionBout = async (
    ringNo: string,
    matchNo: string,
    category: string,
    blueName: string,
    blueClub: string,
    redName: string,
    redClub: string,
    colorToInspect: 'blue' | 'red'
  ) => {
    if (!matchNo.trim()) {
      alert("Match No is required.");
      return;
    }

    const ringNumber = parseRingNumber(ringNo) || 1;

    const data: MatchData = {
      bout: matchNo.toUpperCase().trim(),
      ring: ringNumber,
      category: category ? category.toUpperCase().trim() : 'MANUAL CATEGORY',
      blue_name: blueName ? blueName.toUpperCase().trim() : 'BLUE PLAYER',
      blue_club: blueClub ? blueClub.toUpperCase().trim() : '',
      red_name: redName ? redName.toUpperCase().trim() : 'RED PLAYER',
      red_club: redClub ? redClub.toUpperCase().trim() : '',
      blue_inspected: colorToInspect === 'blue',
      red_inspected: colorToInspect === 'red',
      blue_signature: colorToInspect === 'blue' ? 'MANUAL_INSPEC_BYPASS' : '',
      red_signature: colorToInspect === 'red' ? 'MANUAL_INSPEC_BYPASS' : '',
      blue_checklist: [],
      red_checklist: [],
      eventId: currentEventId || null,
      allowCompleted: true,
      privacy_mode: false,
      inspectedAt: Date.now()
    };

    if (data.category && !categories.includes(data.category)) {
      setCategories(prev => [...prev, data.category]);
    }
    if (data.blue_club && !clubs.includes(data.blue_club)) {
      setClubs(prev => [...prev, data.blue_club]);
    }
    if (data.red_club && !clubs.includes(data.red_club)) {
      setClubs(prev => [...prev, data.red_club]);
    }

    const queueItem = { id: Math.random().toString(36).substr(2, 9), data };
    setBoutQueue(prev => [...prev, queueItem]);

    alert(`Bypass Success: Match ${matchNo.toUpperCase().trim()} created in Ring ${ringNumber} and ${colorToInspect === 'blue' ? 'Chung (Blue)' : 'Hong (Red)'} is marked as inspected!`);
  };

  const handleImportInitialBouts = async () => {
    if (!user?.assignedRing) {
      alert("No ring assigned to this account.");
      return;
    }

    setIsImportingBouts(true);
    try {
      let activeUrl = "https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv";
      if (currentEventId && events.length > 0) {
        const event = events.find(e => e.id === currentEventId);
        const resolvedSpreadsheet = getEventSpreadsheetUrl(event);
        if (resolvedSpreadsheet) {
          activeUrl = resolvedSpreadsheet;
          if (!activeUrl.includes('/export?')) {
            activeUrl = activeUrl.replace(/\/edit.*$/, '') + '/export?format=csv';
          }
        }
      }
      const response = await fetch(activeUrl);
      if (!response.ok) throw new Error("Failed to fetch sheet data.");
      
      const csvText = await response.text();
      const results = Papa.parse<string[]>(csvText, {
        skipEmptyLines: true
      });

      const rows = results.data;
      if (rows.length < 2) {
        alert("Sheet is empty or missing data.");
        return;
      }

      // Skip header row
      const dataRows = rows.slice(1);
      const currentEventName = getCurrentEventName();

      // Filter by event name AND assigned ring
      const ringBouts = dataRows.filter(row => {
        const rowEventName = row[1]?.trim(); // Column B
        const rowRingNo = parseRingNumber(row[2]); // Column C
        return rowEventName && currentEventName &&
               rowEventName.toLowerCase().replace(/\s+/g, '') === currentEventName.toLowerCase().replace(/\s+/g, '') && 
               rowRingNo === Number(user.assignedRing);
      });
      
      if (ringBouts.length === 0) {
        alert(`No bouts found for Event "${currentEventName}" and Ring ${getRingName(Number(user.assignedRing))} in the sheet.`);
        return;
      }

      const newBouts = ringBouts.filter(row => {
        const ringNo = parseRingNumber(row[2]);
        const boutNo = normalizeBoutWithRing(row[3]?.trim(), ringNo);
        // Check if bout already exists in queue or rings
        const existsInQueue = boutQueue.some(q => q.data.eventId === currentEventId && normalizeBoutWithRing(q.data.bout, q.data.ring) === boutNo);
        const existsInRings = rings.some(r => 
          !r.isDeleted && (
            (r.currentBout && r.currentBout.eventId === currentEventId && normalizeBoutWithRing(r.currentBout.bout, r.ringNumber) === boutNo) ||
            (r.onDeck && r.onDeck.eventId === currentEventId && normalizeBoutWithRing(r.onDeck.bout, r.ringNumber) === boutNo) ||
            (r.inTheHole && r.inTheHole.eventId === currentEventId && normalizeBoutWithRing(r.inTheHole.bout, r.ringNumber) === boutNo)
          )
        );
        const existsInHistory = matchHistory.some(h => normalizeBoutWithRing(h.bout, ringNo) === boutNo && h.eventId === currentEventId);
        return !existsInQueue && !existsInRings && !existsInHistory;
      }).map(row => {
        const ringNo = parseRingNumber(row[2]);
        const normalizedBout = normalizeBoutWithRing(row[3]?.trim(), ringNo);
        return {
          id: Math.random().toString(36).substr(2, 9),
          data: {
            ring: ringNo, // Column C
            bout: normalizedBout,
            category: row[4], // Column E
            blue_name: row[5], // Column F
            blue_club: row[6], // Column G
            red_name: row[7], // Column H
            red_club: row[8], // Column I
            privacy_mode: false,
            eventId: currentEventId || null
          } as MatchData
        };
      });

      if (newBouts.length === 0) {
        alert(`No new bouts to import for Ring ${getRingName(Number(user.assignedRing))}. All bouts from sheet already exist in system.`);
        return;
      }

      setBoutQueue(prev => [...prev, ...newBouts]);
      alert(`Successfully imported ${newBouts.length} new bouts for Ring ${getRingName(Number(user.assignedRing))}.`);
    } catch (error) {
      console.error("Error importing bouts:", error);
      alert("Error importing bouts. Please check console for details.");
    } finally {
      setIsImportingBouts(false);
    }
  };

  const handleAdminImportBouts = async () => {
    setIsImportingBouts(true);
    try {
      let activeUrl = "https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv";
      if (currentEventId && events.length > 0) {
        const event = events.find(e => e.id === currentEventId);
        const resolvedSpreadsheet = getEventSpreadsheetUrl(event);
        if (resolvedSpreadsheet) {
          activeUrl = resolvedSpreadsheet;
          if (!activeUrl.includes('/export?')) {
            activeUrl = activeUrl.replace(/\/edit.*$/, '') + '/export?format=csv';
          }
        }
      }
      const response = await fetch(activeUrl);
      if (!response.ok) throw new Error("Failed to fetch sheet data.");
      
      const csvText = await response.text();
      const results = Papa.parse<string[]>(csvText, {
        skipEmptyLines: true
      });

      const rows = results.data;
      if (rows.length < 2) {
        alert("Sheet is empty or missing data.");
        return;
      }

      const dataRows = rows.slice(1);
      const currentEventName = getCurrentEventName();

      const eventBouts = dataRows.filter(row => {
        const rowEventName = row[1]?.trim(); // Column B
        return rowEventName && currentEventName &&
               rowEventName.toLowerCase().replace(/\s+/g, '') === currentEventName.toLowerCase().replace(/\s+/g, '');
      });
      
      if (eventBouts.length === 0) {
        alert(`No bouts found for Event "${currentEventName}" in the sheet.`);
        return;
      }

      const newBouts = eventBouts.filter(row => {
        const ringNo = parseRingNumber(row[2]);
        const boutNo = normalizeBoutWithRing(row[3]?.trim(), ringNo);
        const existsInQueue = boutQueue.some(q => q.data.eventId === currentEventId && normalizeBoutWithRing(q.data.bout, q.data.ring) === boutNo);
        const existsInRings = rings.some(r => 
          !r.isDeleted && (
            (r.currentBout && r.currentBout.eventId === currentEventId && normalizeBoutWithRing(r.currentBout.bout, r.ringNumber) === boutNo) ||
            (r.onDeck && r.onDeck.eventId === currentEventId && normalizeBoutWithRing(r.onDeck.bout, r.ringNumber) === boutNo) ||
            (r.inTheHole && r.inTheHole.eventId === currentEventId && normalizeBoutWithRing(r.inTheHole.bout, r.ringNumber) === boutNo)
          )
        );
        const existsInHistory = matchHistory.some(h => normalizeBoutWithRing(h.bout, ringNo) === boutNo && h.eventId === currentEventId);
        return !existsInQueue && !existsInRings && !existsInHistory;
      }).map(row => {
        const ringNo = parseRingNumber(row[2]);
        const normalizedBout = normalizeBoutWithRing(row[3]?.trim(), ringNo);
        return {
          id: Math.random().toString(36).substr(2, 9),
          data: {
            ring: ringNo, // Column C
            bout: normalizedBout,
            category: row[4], // Column E
            blue_name: row[5], // Column F
            blue_club: row[6], // Column G
            red_name: row[7], // Column H
            red_club: row[8], // Column I
            privacy_mode: false,
            eventId: currentEventId || null
          } as MatchData
        };
      });

      if (newBouts.length === 0) {
        alert(`No new bouts to import for Event "${currentEventName}". All bouts from sheet already exist in system.`);
        return;
      }

      setBoutQueue(prev => [...prev, ...newBouts]);
      alert(`Successfully imported ${newBouts.length} new bouts for Event "${currentEventName}".`);
    } catch (error) {
      console.error("Error importing bouts:", error);
      alert("Error importing bouts. Please check console for details.");
    } finally {
      setIsImportingBouts(false);
    }
  };

  const handleForceSync = async (data: MatchData) => {
    let activeUrl = googleSheetUrl;
    if (!activeUrl && currentEventId && events.length > 0) {
      const event = events.find(e => e.id === currentEventId);
      if (event && event.sheetUrl) {
        activeUrl = event.sheetUrl;
        setGoogleSheetUrl(activeUrl);
      }
    }

    if (activeUrl) {
      setIsSyncing(true);
      try {
        await syncToGoogleSheets(activeUrl, data, getCurrentEventName());
        addToSyncLog('Force Sync', 'success', `Bout ${data.bout} manually synced`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addToSyncLog('Force Sync', 'error', msg);
      } finally {
        setIsSyncing(false);
      }
    } else {
      addToSyncLog('Force Sync', 'error', 'No Google Sheet URL configured');
    }
  };

  const syncResultsFromSheet = async () => {
    if (!currentEventId) {
      console.log('Sync skipped: No currentEventId');
      return;
    }
    let activeUrl = "https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv";
    if (events.length > 0) {
      const event = events.find(e => e.id === currentEventId);
      const resolvedSpreadsheet = getEventSpreadsheetUrl(event);
      if (resolvedSpreadsheet) {
        activeUrl = resolvedSpreadsheet;
        if (!activeUrl.includes('/export?')) {
          activeUrl = activeUrl.replace(/\/edit.*$/, '') + '/export?format=csv';
        }
      }
    }
    const currentEventName = getCurrentEventName();
    setIsSyncing(true);
    console.log('Starting sync from sheet...', activeUrl);
    try {
      const response = await fetch(activeUrl);
      const csvText = await response.text();
      console.log('Fetched CSV text length:', csvText.length);
      
      return new Promise<void>((resolve, reject) => {
        Papa.parse(csvText, {
          complete: async (result) => {
            try {
              const rows = result.data as string[][];
              console.log('Parsed rows count:', rows.length);
              let syncCount = 0;
              for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (row.length >= 10) {
                  // Filter by Event Name (Column B)
                  const rowEventName = row[1]?.trim();
                  if (currentEventName && rowEventName && rowEventName.toLowerCase().replace(/\s+/g, '') !== currentEventName.toLowerCase().replace(/\s+/g, '')) {
                    continue; // Skip bouts that belong to a different event
                  }

                  const ringNo = parseRingNumber(row[2]); // Column C
                  const rawMatchNo = row[3]?.trim(); // Column D
                  const matchNo = normalizeBoutWithRing(rawMatchNo, ringNo);
                  const category = row[4]?.trim(); // Column E
                  const winner = (row.length >= 17 && row[15]) ? row[15]?.trim() : row[9]?.trim(); // Column P for 18-col sheets, else Column J
                  const winnerClub = (row.length >= 17 && row[16]) ? row[16]?.trim() : ''; // Column Q for 18-col sheets

                  if (matchNo && category && winner && winner !== '-' && winner !== '') {
                    const historyId = `${currentEventId}_${matchNo}`;
                    const historyItem = {
                      bout: matchNo,
                      category: category,
                      winner: winner,
                      winnerClub: winnerClub,
                      eventId: currentEventId,
                      ring: ringNo,
                      syncedAt: new Date().toISOString()
                    };
                    
                    console.log(`Syncing result: Bout ${matchNo}, Category ${category}, Winner ${winner}`);
                    if (!isFirestoreQuotaExceeded) {
                      try {
                        await setDoc(doc(db, 'matchHistory', historyId), historyItem);
                      } catch (err: any) {
                        if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
                          handleGlobalQuotaTrigger();
                        }
                      }
                    }
                    syncCount++;
                  }
                }
              }
              
              console.log('Sync completed. Total synced:', syncCount);
              if (syncCount > 0) {
                addToSyncLog('Bracket Sync', 'success', `Synced ${syncCount} results from sheet`);
                alert(`Successfully synced ${syncCount} winners from the Google Sheet.`);
              } else {
                addToSyncLog('Bracket Sync', 'success', 'No new results found in sheet');
                alert("No new winners found in the Google Sheet. Make sure Column J has winner names.");
              }
              resolve();
            } catch (err) {
              console.error('Error in Papa.parse complete:', err);
              reject(err);
            }
          },
          error: (err) => {
            console.error('Papa.parse error:', err);
            reject(err);
          },
          skipEmptyLines: true
        });
      });
    } catch (error) {
      console.error("Error syncing results from sheet:", error);
      addToSyncLog('Bracket Sync', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      setIsSyncing(false);
    }
  };

  const pullBout = async (queueId: string) => {
    const item = boutQueue.find(q => q.id === queueId);
    if (!item) return;

    // Put current active match into suspended list instead of returning to queue
    const ring = rings.find(r => r.ringNumber === item.data.ring);
    if (ring && ring.currentBout && hasPlayers(ring.currentBout)) {
      const currentBout = ring.currentBout;
      setRings(prev => {
        const updated = prev.map(r => {
          if (r.ringNumber === item.data.ring) {
            const suspended = r.suspendedBouts ? [...r.suspendedBouts] : [];
            if (!suspended.some(b => isBoutMatch(b.bout, currentBout.bout))) {
              suspended.push({ ...currentBout, eventId: currentEventId || null });
            }
            return {
              ...r,
              suspendedBouts: suspended
            };
          }
          return r;
        });
        localStorage.setItem('tkd_rings', JSON.stringify(updated));
        return updated;
      });
    }

    // Remove from queue
    setBoutQueue(prev => {
      const updated = prev.filter(q => q.id !== queueId);
      localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
      return updated;
    });

    // Update ring
    handleBoutUpdate(item.data.ring, item.data);
  };

  const deleteBoutFromQueue = (queueId: string) => {
    setBoutQueue(prev => {
      const updated = prev.filter(q => q.id !== queueId);
      localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
      return updated;
    });
  };

  const removeBoutFromRingSlot = (ringNumber: number, slot: 'onDeck' | 'inTheHole') => {
    setRings(prev => {
      const updated = prev.map(r => r.ringNumber === ringNumber ? {
        ...r,
        [slot]: null
      } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });
  };

  const transferBoutFromRingSlot = (ringNumber: number, slot: 'onDeck' | 'inTheHole', targetRing: number) => {
    const ring = rings.find(r => r.ringNumber === ringNumber);
    const match = ring ? ring[slot] : null;
    if (!match) return;

    setRings(prev => {
      const updated = prev.map(r => r.ringNumber === ringNumber ? {
        ...r,
        [slot]: null
      } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });

    const updatedMatch = {
      ...match,
      ring: targetRing,
      originalRing: match.originalRing || ringNumber
    };

    setBoutQueue(prev => {
      const updated = [...prev, {
        id: Math.random().toString(36).substr(2, 9),
        data: updatedMatch
      }];
      localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
      return updated;
    });

    addToSyncLog("Transfer Bout Ring", "success", `Transferred Bout ${match.bout} from Ring ${getRingName(ringNumber)} to Ring ${getRingName(targetRing)}`);

    if (!isFirestoreQuotaExceeded) {
      addDoc(collection(db, 'bout_transfers'), {
        fromRing: ringNumber.toString(),
        toRing: targetRing.toString(),
        boutNumber: match.bout.toString().toUpperCase(),
        timestamp: serverTimestamp(),
        pinnedUntil: new Date(new Date().getTime() + 30 * 60 * 1000).toISOString(),
        isPinned: true,
        author: user?.username || 'Admin'
      }).catch(err => console.error("Auto transfer broadcast error:", err));
    }
  };

  const pullRingSlotToActive = (ringNumber: number, slot: 'onDeck' | 'inTheHole') => {
    const ring = rings.find(r => r.ringNumber === ringNumber);
    const itemData = ring ? ring[slot] : null;
    if (!itemData) return;

    // Put current active match into suspended list
    if (ring && ring.currentBout && hasPlayers(ring.currentBout)) {
      const currentBout = ring.currentBout;
      setRings(prev => {
        const updated = prev.map(r => {
          if (r.ringNumber === ringNumber) {
            const suspended = r.suspendedBouts ? [...r.suspendedBouts] : [];
            if (!suspended.some(b => isBoutMatch(b.bout, currentBout.bout))) {
              suspended.push({ ...currentBout, eventId: currentEventId || null });
            }
            return {
              ...r,
              suspendedBouts: suspended,
              [slot]: null
            };
          }
          return r;
        });
        localStorage.setItem('tkd_rings', JSON.stringify(updated));
        return updated;
      });
    } else {
      setRings(prev => {
        const updated = prev.map(r => r.ringNumber === ringNumber ? {
          ...r,
          [slot]: null
        } : r);
        localStorage.setItem('tkd_rings', JSON.stringify(updated));
        return updated;
      });
    }

    // Update ring
    handleBoutUpdate(ringNumber, itemData);
  };

  const handleMissingBoutReason = async (ringNumber: number, boutNumber: number, reason: string) => {
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNumber);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    // Close prompt immediately for responsiveness
    setMissingBoutPrompt(null);

    if (googleSheetUrl) {
      setIsSyncing(true);
      const dummyMatch: MatchData = {
        ring: ringNumber,
        bout: boutNumber,
        category: "Skipped",
        blue_name: "-",
        blue_club: "-",
        red_name: "-",
        red_club: "-",
        privacy_mode: false,
        eventId: currentEventId || null
      };
      
      // Sync in background
      Promise.all([
        syncToGoogleSheets(googleSheetUrl, dummyMatch, getCurrentEventName(), reason),
        updateWinnerInGoogleSheets(googleSheetUrl, ringNumber, boutNumber, reason, getCurrentEventName(), 'N/A')
      ]).finally(() => setIsSyncing(false));
    }

    const ring = rings.find(r => r.ringNumber === ringNumber);
    const nextExpectedBout = boutNumber + 1;

    // Update the ring's nextBoutNumber
    setRings(prev => {
      const updated = prev.map(r => r.ringNumber === ringNumber ? { ...r, nextBoutNumber: nextExpectedBout } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });

    if (ring && ring.totalBouts && nextExpectedBout <= ring.totalBouts) {
      const nextBoutIndex = boutQueue.findIndex(q => q.data.ring === ringNumber && (!q.data.eventId || q.data.eventId === currentEventId));
      if (nextBoutIndex !== -1) {
        pullBout(boutQueue[nextBoutIndex].id);
      }
    }
    
    // Always close the prompt after recording a reason.
    // If there's no next bout in the queue, the ring will just become inactive.
    setMissingBoutPrompt(null);
  };

  const handleUpdateBoutNumberFromBracket = async (oldBoutId: string, newBoutId: string) => {
    // Determine the ring number from newBoutId if possible, or keep the old one?
    // Wait, oldBoutId looks like 'E09', newBoutId looks like 'E11'.
    // The bout property is 'E09'. We need to update it to 'E11'.
    
    // 1. Update matching bout in boutQueue
    let oldBoutRing = 1;
    let modifiedItems: MatchData[] = [];
    
    // We compute the new queue directly using the current boutQueue state, so we have immediate access to modifiedItems
    const updatedQueue = boutQueue.map(item => {
      const itemBout = normalizeBoutNumber(item.data.bout.toString());
      const oldBoutNorm = normalizeBoutNumber(oldBoutId);
      
      let newItem = { ...item };
      let modified = false;

      if (itemBout === oldBoutNorm) {
        // This is the bout being renamed
        newItem.data = { ...newItem.data, bout: newBoutId };
        oldBoutRing = item.data.ring;
        modified = true;
      }

      // 2. Update dependent future matches
      const oldWinnerPlaceholderStr = `WINNER OF ${oldBoutId.toUpperCase()}`;
      const oldWinnerPlaceholderNorm = `WINNER OF ${oldBoutNorm.toUpperCase()}`;
      
      if (newItem.data.blue_name && (newItem.data.blue_name.toUpperCase().includes(oldWinnerPlaceholderStr) || newItem.data.blue_name.toUpperCase().includes(oldWinnerPlaceholderNorm))) {
         newItem.data = { ...newItem.data, blue_name: newItem.data.blue_name.replace(new RegExp(`WINNER OF ${oldBoutId}`, 'i'), `WINNER OF ${newBoutId}`).replace(new RegExp(`WINNER OF ${oldBoutNorm}`, 'i'), `WINNER OF ${newBoutId}`) };
         modified = true;
      }
      if (newItem.data.red_name && (newItem.data.red_name.toUpperCase().includes(oldWinnerPlaceholderStr) || newItem.data.red_name.toUpperCase().includes(oldWinnerPlaceholderNorm))) {
         newItem.data = { ...newItem.data, red_name: newItem.data.red_name.replace(new RegExp(`WINNER OF ${oldBoutId}`, 'i'), `WINNER OF ${newBoutId}`).replace(new RegExp(`WINNER OF ${oldBoutNorm}`, 'i'), `WINNER OF ${newBoutId}`) };
         modified = true;
      }
      
      if (modified) modifiedItems.push(newItem.data);
      return modified ? newItem : item;
    });

    // 3. Sort chronologically by their ID sequence
    updatedQueue.sort((a, b) => String(a.data.bout).localeCompare(String(b.data.bout)));
    
    setBoutQueue(updatedQueue);
    localStorage.setItem('tkd_bout_queue', JSON.stringify(updatedQueue));

    // 4. Update Mappings
    if (currentEventId) {
       // Search local mappings for sourceBout or nextBout
       setMappings(prev => {
          return prev.map(m => {
             let mChanged = false;
             let mObj = { ...m };
             if (normalizeBoutNumber(m.sourceBout) === normalizeBoutNumber(oldBoutId)) {
                mObj.sourceBout = newBoutId;
                mChanged = true;
             }
             if (normalizeBoutNumber(m.nextBout) === normalizeBoutNumber(oldBoutId)) {
                mObj.nextBout = newBoutId;
                mChanged = true;
             }
             if (mChanged) {
                // Also update in firestore
                if (!isFirestoreQuotaExceeded) {
                   setDoc(doc(db, 'event_logic', m.id), mObj).catch(() => {});
                }
             }
             return mChanged ? mObj : m;
          });
       });
    }

    // 5. Trigger broadcast to Firebase/Sheets if needed
    // The handleBoutUpdate can update sheets
    setTimeout(() => {
       if (googleSheetUrl) {
           modifiedItems.forEach(updatedQueueItem => {
               updateBoutDetailsInGoogleSheets(
                  googleSheetUrl, 
                  updatedQueueItem.ring, // Use its own ring or oldBoutRing? Safe to use its current ring
                  updatedQueueItem.bout, 
                  updatedQueueItem.blue_name || '',
                  updatedQueueItem.blue_club || '',
                  updatedQueueItem.red_name || '',
                  updatedQueueItem.red_club || '',
                  getCurrentEventName()
               ).catch(console.error);
           });
       }
       window.dispatchEvent(new CustomEvent('tkd_force_propagate_winners'));
    }, 500);
  };

  const handleUpdateBoutNameFromBracket = async (boutId: string, color: 'blue' | 'red', newName: string) => {
    let oldBoutRing = 1;
    let modifiedItem: MatchData | null = null;
    const targetBoutNorm = normalizeBoutNumber(boutId);
    
    // 1. Update in boutQueue
    const updatedQueue = boutQueue.map(item => {
      const itemBout = normalizeBoutNumber(item.data.bout.toString());
      let newItem = { ...item };
      
      if (itemBout === targetBoutNorm) {
        if (color === 'blue') {
          newItem.data = { ...newItem.data, blue_name: newName };
        } else {
          newItem.data = { ...newItem.data, red_name: newName };
        }
        modifiedItem = newItem.data;
        return newItem;
      }
      return item;
    });

    setBoutQueue(updatedQueue);
    localStorage.setItem('tkd_bout_queue', JSON.stringify(updatedQueue));

    // 2. Update active rings
    setRings(prev => prev.map(r => {
      const newRing = { ...r };
      let changed = false;
      
      if (r.currentBout && normalizeBoutNumber(r.currentBout.bout) === targetBoutNorm) {
        if (color === 'blue') {
          newRing.currentBout = { ...r.currentBout, blue_name: newName };
        } else {
          newRing.currentBout = { ...r.currentBout, red_name: newName };
        }
        modifiedItem = newRing.currentBout;
        changed = true;
      }
      if (r.onDeck && normalizeBoutNumber(r.onDeck.bout) === targetBoutNorm) {
        if (color === 'blue') {
          newRing.onDeck = { ...r.onDeck, blue_name: newName };
        } else {
          newRing.onDeck = { ...r.onDeck, red_name: newName };
        }
        modifiedItem = newRing.onDeck;
        changed = true;
      }
      if (r.inTheHole && normalizeBoutNumber(r.inTheHole.bout) === targetBoutNorm) {
        if (color === 'blue') {
          newRing.inTheHole = { ...r.inTheHole, blue_name: newName };
        } else {
          newRing.inTheHole = { ...r.inTheHole, red_name: newName };
        }
        modifiedItem = newRing.inTheHole;
        changed = true;
      }

      return changed ? newRing : r;
    }));
    
    setTimeout(() => {
       if (googleSheetUrl && modifiedItem) {
           updateBoutDetailsInGoogleSheets(
              googleSheetUrl, 
              modifiedItem.ring, 
              modifiedItem.bout, 
              modifiedItem.blue_name || '',
              modifiedItem.blue_club || '',
              modifiedItem.red_name || '',
              modifiedItem.red_club || '',
              getCurrentEventName()
           ).catch(console.error);
       }
       window.dispatchEvent(new CustomEvent('tkd_force_propagate_winners'));
    }, 500);
  };

  const handleUpdateMatchInspection = async (ringNoStr: string, matchNo: string, color: 'blue' | 'red', inspected: boolean, signature?: string, checklist?: string[]) => {
    const ringNoNum = parseRingNumber(ringNoStr);
    const ringNo = ringNoNum.toString();
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNoNum);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    const updateData = (match: MatchData) => {
      const updated = { 
        ...match, 
        [`${color}_inspected`]: inspected,
        inspectedAt: Date.now()
      };
      if (signature) updated[`${color}_signature`] = signature;
      if (checklist) updated[`${color}_checklist`] = checklist;
      return updated;
    };

    setRings(prev => {
      let changed = false;
      const updated = prev.map(ring => {
        if (ring.ringNumber.toString() === ringNo) {
          let r = { ...ring };
          let ringChanged = false;
          if (r.currentBout && isBoutMatch(r.currentBout.bout, matchNo)) {
            r.currentBout = updateData(r.currentBout);
            ringChanged = true;
          }
          if (r.onDeck && isBoutMatch(r.onDeck.bout, matchNo)) {
            r.onDeck = updateData(r.onDeck);
            ringChanged = true;
          }
          if (r.inTheHole && isBoutMatch(r.inTheHole.bout, matchNo)) {
            r.inTheHole = updateData(r.inTheHole);
            ringChanged = true;
          }
          if (ringChanged) {
            changed = true;
            return r;
          }
        }
        return ring;
      });
      return changed ? updated : prev;
    });

    setBoutQueue(prev => {
      let changed = false;
      const updated = prev.map(item => {
        if (item.data.ring.toString() === ringNo && isBoutMatch(item.data.bout, matchNo)) {
          changed = true;
          return { ...item, data: updateData(item.data) };
        }
        return item;
      });
      return changed ? updated : prev;
    });
  };

  const handleMissingBoutManual = async (ringNumber: number, data: MatchData) => {
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNumber);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    setMissingBoutPrompt(null);
    handleBoutUpdate(ringNumber, data);
  };

  useEffect(() => {
    // Advancement logic: Pull winners to next bouts based on mappings
    return; // DISABLED TO PREVENT RACE CONDITIONS
    if (!currentEventId) {
      return;
    }

    const normalizeStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();

    // Group mappings by target bout to handle both slots
    const targetBouts = new Map<string, { category: string, bout: string, blue?: string, red?: string, blueClub?: string, redClub?: string }>();

    mappings.forEach(mapping => {
      // Prioritize matching by category if available, otherwise fallback
      let match = matchHistory.find(h => {
        const boutsMatch = isBoutMatch(h.bout, mapping.sourceBout);
        const eventIdMatch = h.eventId === currentEventId;
        const catMatch = mapping.categoryName && 
                         mapping.categoryName !== "Auto-Extracted" && 
                         mapping.categoryName !== "Auto-Extracted from File" && 
                         normalizeStr(h.category) === normalizeStr(mapping.categoryName);
        return boutsMatch && eventIdMatch && catMatch;
      });

      if (!match) {
        match = matchHistory.find(h => {
          const boutsMatch = isBoutMatch(h.bout, mapping.sourceBout);
          const eventIdMatch = h.eventId === currentEventId;
          const catMatch = !mapping.categoryName || 
                           mapping.categoryName === "Auto-Extracted" || 
                           mapping.categoryName === "Auto-Extracted from File" || 
                           normalizeStr(h.category) === normalizeStr(mapping.categoryName);
          return boutsMatch && eventIdMatch && catMatch;
        });
      }

      if (match) {
        // Use normalized bout number as the key to group mappings for the same target match
        const key = normalizeBoutNumber(mapping.nextBout);
        if (!targetBouts.has(key)) {
          targetBouts.set(key, { category: mapping.categoryName, bout: mapping.nextBout });
        }
        const target = targetBouts.get(key)!;
        if (mapping.slot === 'Chung') {
          target.blue = match.winner;
          target.blueClub = (match.winnerClub || '').toUpperCase();
        }
        if (mapping.slot === 'Hong') {
          target.red = match.winner;
          target.redClub = (match.winnerClub || '').toUpperCase();
        }
        
        // If the mapping has a real category, use it instead of "Auto-Extracted"
        if (mapping.categoryName && mapping.categoryName !== "Auto-Extracted") {
          target.category = mapping.categoryName;
        }
      } else {
        // No match found in history yet! Ensure the placeholder is presented so we don't display older, buggy, or leaked winner data.
        const key = normalizeBoutNumber(mapping.nextBout);
        if (!targetBouts.has(key)) {
          // Resolve category
          let mCat = mapping.categoryName;
          if (!mCat || mCat === "Auto-Extracted" || mCat === "Auto-Extracted from File") {
            const queueMatch = boutQueue.find(b => isBoutMatch(b.data.bout, mapping.nextBout)) ||
                               rings.flatMap(r => [r.currentBout, r.onDeck, r.inTheHole]).find(b => b && isBoutMatch(b.bout, mapping.nextBout));
            if (queueMatch) {
              mCat = queueMatch.category || queueMatch.data?.category || '';
            }
          }
          targetBouts.set(key, { category: mCat || '', bout: mapping.nextBout });
        }
        const target = targetBouts.get(key)!;
        
        // Construct standard placeholder string (e.g. "WINNER OF F22B")
        const ringNo = parseRingNumber(mapping.sourceBout);
        const placeholderStr = `WINNER OF ${formatBoutNumber(ringNo, mapping.sourceBout)}`;
        
        if (mapping.slot === 'Chung') {
          if (!target.blue) {
            target.blue = placeholderStr;
            target.blueClub = '';
          }
        }
        if (mapping.slot === 'Hong') {
          if (!target.red) {
            target.red = placeholderStr;
            target.redClub = '';
          }
        }
      }
    });

    // FALLBACK: Auto-detect "WINNER OF X" phrasing in matches and pull from match history
    const applyFallbackWinner = (boutData: MatchData | null | undefined) => {
      if (!boutData) return;
      const checkWinnerStr = (nameStr: string, slot: 'blue' | 'red') => {
        if (!nameStr) return;
        const sourceBoutStr = extractWinnerOfBout(nameStr);
        if (sourceBoutStr) {
          let historyMatch = matchHistory.find(h => 
            isBoutMatch(h.bout, sourceBoutStr) && 
            h.eventId === currentEventId &&
            normalizeStr(h.category) === normalizeStr(boutData.category)
          );
          
          if (!historyMatch) {
            historyMatch = matchHistory.find(h => 
              isBoutMatch(h.bout, sourceBoutStr) && 
              h.eventId === currentEventId
            );
          }
          
          if (historyMatch && historyMatch.winner && historyMatch.winner !== '-' && historyMatch.winner.trim() !== '') {
            console.log(`Fallback detected: Match ${boutData.bout} (${slot}) needs WINNER OF ${sourceBoutStr}. Found winner: ${historyMatch.winner}`);
            const key = normalizeBoutNumber(boutData.bout);
            if (!targetBouts.has(key)) {
              targetBouts.set(key, { category: boutData.category, bout: String(boutData.bout) });
            }
            const target = targetBouts.get(key)!;
            if (slot === 'blue' && (!target.blue || target.blue === 'WINNER' || target.blue.includes('WINNER OF'))) {
              target.blue = historyMatch.winner.toUpperCase();
              target.blueClub = historyMatch.winnerClub ? historyMatch.winnerClub.toUpperCase() : '';
            } else if (slot === 'red' && (!target.red || target.red === 'WINNER' || target.red.includes('WINNER OF'))) {
              target.red = historyMatch.winner.toUpperCase();
              target.redClub = historyMatch.winnerClub ? historyMatch.winnerClub.toUpperCase() : '';
            }
          } else {
            console.log(`Fallback checked: Match ${boutData.bout} (${slot}) needs WINNER OF ${sourceBoutStr}, but no valid winner found in history.`);
          }
        }
      };
      checkWinnerStr(boutData.blue_name, 'blue');
      checkWinnerStr(boutData.red_name, 'red');
    };

    boutQueue.forEach(item => applyFallbackWinner(item.data));
    rings.forEach(ring => {
      applyFallbackWinner(ring.currentBout);
      applyFallbackWinner(ring.onDeck);
      applyFallbackWinner(ring.inTheHole);
    });

    if (targetBouts.size === 0) return;

    let changed = false;
    let updatedQueue = [...boutQueue];
    let updatedRings = [...rings];

    targetBouts.forEach((info) => {
      let found = false;
      const targetBoutStr = info.bout;

      const shouldUpdateField = (current: string, next: string | undefined): boolean => {
        if (!next) return false;
        const normCurrent = (current || '').trim().toUpperCase();
        const normNext = next.trim().toUpperCase();
        if (normCurrent === normNext) return false;

        const currentIsRealName = normCurrent !== '' && 
          normCurrent !== '-' && 
          normCurrent !== '---' && 
          !normCurrent.startsWith('WINNER OF ') && 
          cleanPlaceholder(current) !== '---';
        const nextIsRealName = normNext !== '' && 
          normNext !== '-' && 
          normNext !== '---' && 
          !normNext.startsWith('WINNER OF ') && 
          cleanPlaceholder(next) !== '---';

        // If current is already a real name, DO NOT overwrite it.
        // This preserves manual edits directly made in the UI or Google Sheets
        // and prevents subsequent bracket logic from quietly reverting intentional corrections.
        if (currentIsRealName) {
          return false;
        }

        return true;
      };

      // Check rings
      updatedRings = updatedRings.map(ring => {
        let ringDocChanged = false;
        const updateBout = (bout: MatchData | null) => {
          if (bout && isBoutMatch(bout.bout, targetBoutStr)) {
            found = true;
            const newData = { ...bout };
            let boutChanged = false;
            
            if (info.blue && shouldUpdateField(newData.blue_name, info.blue)) {
              console.log(`Advancing ${info.blue} to Ring ${ring.ringNumber} Bout ${bout.bout} (Chung)`);
              newData.blue_name = info.blue.toUpperCase();
              if (info.blueClub) newData.blue_club = info.blueClub.toUpperCase();
              boutChanged = true;
            }
            if (info.red && shouldUpdateField(newData.red_name, info.red)) {
              console.log(`Advancing ${info.red} to Ring ${ring.ringNumber} Bout ${bout.bout} (Hong)`);
              newData.red_name = info.red.toUpperCase();
              if (info.redClub) newData.red_club = info.redClub.toUpperCase();
              boutChanged = true;
            }
            
            if (boutChanged) {
              ringDocChanged = true;
              changed = true;
            }
            return newData;
          }
          return bout;
        };

        const newCurrent = updateBout(ring.currentBout);
        const newOnDeck = updateBout(ring.onDeck);
        const newInTheHole = updateBout(ring.inTheHole);

        if (ringDocChanged) {
          return { ...ring, currentBout: newCurrent, onDeck: newOnDeck, inTheHole: newInTheHole };
        }
        return ring;
      });

      // Check queue
      updatedQueue = updatedQueue.map(item => {
        if (isBoutMatch(item.data.bout, targetBoutStr)) {
          found = true;
          const newData = { ...item.data };
          let itemChanged = false;

          if (info.blue && shouldUpdateField(newData.blue_name, info.blue)) {
            console.log(`Advancing ${info.blue} to Queue Bout ${item.data.bout} (Chung) - REPLACING: ${newData.blue_name}`);
            newData.blue_name = info.blue.toUpperCase();
            if (info.blueClub) newData.blue_club = info.blueClub.toUpperCase();
            itemChanged = true;
          }
          if (info.red && shouldUpdateField(newData.red_name, info.red)) {
            console.log(`Advancing ${info.red} to Queue Bout ${item.data.bout} (Hong) - REPLACING: ${newData.red_name}`);
            newData.red_name = info.red.toUpperCase();
            if (info.redClub) newData.red_club = info.redClub.toUpperCase();
            itemChanged = true;
          }
          
          if (itemChanged) {
            changed = true;
            return { ...item, data: newData };
          }
        }
        return item;
      });

      // If not found anywhere, generate it (only if both players are available as per user request)
      if (!found && info.blue && info.red) {
        const normalizedTarget = normalizeBoutNumber(targetBoutStr);
        const boutNum = parseInt(normalizedTarget);
        const prefix = normalizedTarget.charAt(0).toUpperCase();
        let ringNum = 1;

        if (!isNaN(boutNum) && boutNum >= 1000) {
          ringNum = Math.floor(boutNum / 1000);
        } else if (prefix === 'A') ringNum = 1;
        else if (prefix === 'B') ringNum = 2;
        else if (prefix === 'C') ringNum = 3;
        else if (prefix === 'D') ringNum = 4;
        else if (prefix === 'E') ringNum = 5;
        else if (prefix === 'F') ringNum = 6;
        else if (prefix === 'G') ringNum = 7;
        else if (prefix === 'H') ringNum = 8;
        
        const newBout: MatchData = {
          ring: ringNum,
          bout: targetBoutStr,
          category: info.category,
          blue_name: (info.blue || '').toUpperCase(),
          blue_club: (info.blueClub || '').toUpperCase(),
          red_name: (info.red || '').toUpperCase(),
          red_club: (info.redClub || '').toUpperCase(),
          privacy_mode: false,
          eventId: currentEventId
        };

        updatedQueue.push({
          id: `gen_${currentEventId}_${targetBoutStr}_${info.category}`,
          data: newBout
        });
        changed = true;
      }
    });

    if (changed) {
      console.log('Players advanced to next bouts based on mappings');
      setBoutQueue(updatedQueue);
      setRings(updatedRings);
      localStorage.setItem('tkd_bout_queue', JSON.stringify(updatedQueue));
      localStorage.setItem('tkd_rings', JSON.stringify(updatedRings));
    }
  }, [mappings, matchHistory, currentEventId, boutQueue, rings]);

  // Auto-pull logic removed as per user request (manual pull only)
  
  const handleWinnerSelect = async (ringNumber: number, boutNumber: string | number, winner: string) => {
    if (confirmResultSubmission) {
      setPendingWinnerSelection({ ringNumber, boutNumber, winner });
    } else {
      executeWinnerSelect(ringNumber, boutNumber, winner);
    }
  };

  const executeWinnerSelect = async (ringNumber: number, boutNumber: string | number, winner: string) => {
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNumber);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    let activeUrl = googleSheetUrl;
    if (!activeUrl && currentEventId && events.length > 0) {
      const event = events.find(e => e.id === currentEventId);
      if (event && event.sheetUrl) {
        activeUrl = event.sheetUrl;
        setGoogleSheetUrl(activeUrl);
      }
    }

    const ring = rings.find(r => r.ringNumber === ringNumber);
    const currentBout = ring?.currentBout;
    const isCompleted = winner === 'Completed';
    const winnerName = isCompleted 
      ? (currentBout?.blue_name || currentBout?.red_name || 'Completed') 
      : (winner === 'Blue' ? currentBout?.blue_name : currentBout?.red_name);

    const targetSyncRing = currentBout?.originalRing || ringNumber;
    const winnerClub = isCompleted 
      ? (currentBout?.blue_club || currentBout?.red_club || '-') 
      : (winner === 'Blue' ? currentBout?.blue_club : (winner === 'Red' ? currentBout?.red_club : '-'));

    if (activeUrl) {
      setIsSyncing(true);
      setLastSyncError(null);
      updateWinnerInGoogleSheets(
        activeUrl, 
        targetSyncRing, 
        boutNumber, 
        winnerName || winner,
        getCurrentEventName(),
        winner,
        currentBout?.blue_name,
        currentBout?.red_name,
        currentBout?.points,
        winnerClub,
        currentBout?.blue_club,
        currentBout?.red_club
      ).then(() => {
        addToSyncLog('Winner', 'success', `Winner for Bout ${boutNumber} sent`);
      }).catch(e => {
        const msg = e instanceof Error ? e.message : String(e);
        setLastSyncError(`Winner sync failed: ${msg}`);
        addToSyncLog('Winner', 'error', msg);
      }).finally(() => setIsSyncing(false));
    }

    // Save to match history for advancement logic
    if (currentEventId && currentBout) {
      const historyItem: MatchHistoryItem = {
        id: `${currentEventId}_${normalizeBoutNumber(boutNumber)}`,
        bout: normalizeBoutNumber(boutNumber),
        category: currentBout.category,
        winner: winnerName || winner,
        winnerClub: winner === 'Blue' ? currentBout.blue_club : (winner === 'Red' ? currentBout.red_club : '-'),
        winnerSide: (winner === 'Blue' || winner === 'Red') ? (winner as 'Blue' | 'Red') : undefined,
        eventId: currentEventId,
        ring: ringNumber
      };
      
      setMatchHistory(prev => {
        const filtered = prev.filter(h => h.id !== historyItem.id);
        const updated = [...filtered, historyItem];
        return updated;
      });

      // Also save to Firestore
      const historyId = `${currentEventId}_${normalizeBoutNumber(boutNumber)}`;
      const toSave: any = {
        ...historyItem,
        syncedAt: serverTimestamp()
      };
      if (toSave.winnerSide === undefined) delete toSave.winnerSide;
      if (toSave.winnerClub === undefined) delete toSave.winnerClub;
      
      if (!isFirestoreQuotaExceeded) {
        setDoc(doc(db, 'matchHistory', historyId), toSave).catch(err => {
          console.error("Error saving match history:", err);
          if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
            handleGlobalQuotaTrigger();
          }
        });
      }

      // Check and generate next bout
      checkAndGenerateNextBout(boutNumber, winnerName || winner, winner === 'Blue' ? currentBout.blue_club : currentBout.red_club, currentBout.category);
    }
    
    const completedBoutIds = new Set(
      matchHistory
        .filter(h => h.eventId === currentEventId && h.winner && h.winner !== '-' && h.winner.trim() !== '')
        .map(h => normalizeBoutNumber(h.bout))
    );

    const ringQueue = boutQueue.filter(q => 
      q.data.ring === ringNumber && 
      (!q.data.eventId || q.data.eventId === currentEventId) &&
      !completedBoutIds.has(normalizeBoutNumber(q.data.bout))
    );
    const nextBoutIndex = boutQueue.findIndex(q => 
      q.data.ring === ringNumber && 
      (!q.data.eventId || q.data.eventId === currentEventId) &&
      !completedBoutIds.has(normalizeBoutNumber(q.data.bout))
    );
    
    // Check if we need to prompt for final bouts
    // If we have a next bout, and after pulling it, the queue for this ring will be < 3
    if (nextBoutIndex !== -1 && !ring?.isFinalBouts && ringQueue.length < 4) {
      setFinalBoutCheck({ ringNumber, remainingCount: ringQueue.length - 1 });
    }

    // Auto-advance ring: Move onDeck to current, inTheHole to onDeck
    let pulledFromQueue = false;
    let nextItemToPull: {id: string, data: MatchData} | null = null;

    if (autoPullRings[ringNumber] && !ring?.onDeck) {
      if (ringQueue.length > 0) {
        nextItemToPull = ringQueue[0];
        pulledFromQueue = true;
      }
    }

    setRings(prev => {
      const updated = prev.map(r => {
        if (r.ringNumber === ringNumber) {
          let nextBout = r.onDeck;
          let nextNextBout = r.inTheHole;
          
          if (!nextBout && pulledFromQueue && nextItemToPull) {
            nextBout = nextItemToPull.data;
          }

          return {
            ...r,
            currentBout: nextBout,
            onDeck: nextNextBout,
            inTheHole: null,
            nextBoutNumber: nextBout ? getBoutNumber(nextBout.bout) + 1 : r.nextBoutNumber
          };
        }
        return r;
      });
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });

    if (pulledFromQueue && nextItemToPull) {
      setBoutQueue(prev => {
        const updated = prev.filter(q => q.id !== nextItemToPull!.id);
        localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
        return updated;
      });
    }

    // Sync the new current bout to Google Sheets if it exists
    const nextBoutToSyncWin = ring?.onDeck || (pulledFromQueue && nextItemToPull ? nextItemToPull.data : null);
    if (nextBoutToSyncWin && activeUrl) {
      const dataToSync = { ...nextBoutToSyncWin, ring: nextBoutToSyncWin.originalRing || nextBoutToSyncWin.ring };
      syncToGoogleSheets(activeUrl, dataToSync, getCurrentEventName());
    }

    // If queue is empty but we haven't reached total bouts, show the missing bout prompt
    if (ring && ring.totalBouts && !ring.onDeck && !ring.inTheHole && ringQueue.length === (pulledFromQueue ? 1 : 0) && getBoutNumber(ring.currentBout?.bout || 0) < ring.totalBouts) {
      setMissingBoutPrompt({ ringNumber, expectedBout: getBoutNumber(ring.currentBout?.bout || 0) + 1, totalBouts: ring.totalBouts });
    }
  };


  const handleRestoreMatch = async (matchToRestore: MatchHistoryItem) => {
    if (!currentEventId) return;

    let activeUrl = googleSheetUrl;
    if (!activeUrl && currentEventId && events.length > 0) {
      const event = events.find(e => e.id === currentEventId);
      if (event && event.sheetUrl) {
        activeUrl = event.sheetUrl;
      }
    }

    const ringToUse = matchToRestore.ring || getRingFromBout(matchToRestore.bout) || 1;

    const newBoutId = `restored_${currentEventId}_${Date.now()}`;
    const restoredMatchData: MatchData = {
      ring: ringToUse,
      originalRing: ringToUse,
      bout: matchToRestore.bout,
      category: matchToRestore.category || '',
      blue_name: '',
      blue_club: '',
      red_name: '',
      red_club: '',
      points: {},
      eventId: currentEventId,
      allowCompleted: true,
      privacy_mode: false
    };

    setRings(prevRings => {
      let ringUpdated = false;
      const updatedRings = prevRings.map(r => {
        let newRing = { ...r };
        let changed = false;
        ['currentBout', 'onDeck', 'inTheHole'].forEach(slot => {
          const slotBout = newRing[slot as keyof typeof newRing] as MatchData | null;
          if (slotBout && slotBout.bout && isBoutMatch(slotBout.bout, matchToRestore.bout)) {
            (newRing as any)[slot] = null;
            changed = true;
            ringUpdated = true;
          }
        });
        
        // Compact slots if needed
        if (changed) {
           if (!newRing.currentBout && newRing.onDeck) {
             newRing.currentBout = newRing.onDeck;
             newRing.onDeck = newRing.inTheHole;
             newRing.inTheHole = null;
           } else if (!newRing.onDeck && newRing.inTheHole) {
             newRing.onDeck = newRing.inTheHole;
             newRing.inTheHole = null;
           }
        }
        return newRing;
      });
      
      if (ringUpdated) {
        localStorage.setItem('tkd_rings', JSON.stringify(updatedRings));
        return updatedRings;
      }
      return prevRings;
    });

    setBoutQueue(prev => {
      // Actively remove any existing queue items for this bout to prevent uniqueQueue collision
      const filtered = prev.filter(q => {
        const qRing = q.data.ring || 1;
        if (isBoutMatch(q.data.bout, matchToRestore.bout) && qRing === ringToUse) {
           return false;
        }
        return true;
      });
      const updated = [...filtered, { id: newBoutId, data: restoredMatchData }];
      return updated;
    });

    setMatchHistory(prev => {
      const updated = prev.filter(h => h.id !== matchToRestore.id);
      return updated;
    });

    if (!isFirestoreQuotaExceeded) {
      deleteDoc(doc(db, 'matchHistory', matchToRestore.id)).catch(err => {
        console.error("Error removing restored match from history:", err);
      });
    }

    if (activeUrl) {
      updateWinnerInGoogleSheets(
        activeUrl, 
        ringToUse, 
        matchToRestore.bout, 
        '-', 
        getCurrentEventName(), 
        '-', 
        '-', 
        '-'
      ).catch(e => console.error("Error clearing winner in sheets:", e));
    }

    // Try to auto-populate the player names from Google Sheets right away
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('tkd_force_propagate_winners'));
    }, 1000);
  };

  const getRingFromBout = (bout: string | number): number => {
    const boutStr = bout.toString().toUpperCase();
    const prefix = boutStr.charAt(0);
    const boutNum = parseInt(boutStr.replace(/[^0-9]/g, ''));
    
    // Numeric range logic (1000s = Ring 1, 2000s = Ring 2, etc.)
    if (!isNaN(boutNum) && boutNum >= 1000) {
      return Math.floor(boutNum / 1000);
    }
    
    // Letter prefix logic
    if (prefix === 'A') return 1;
    if (prefix === 'B') return 2;
    if (prefix === 'C') return 3;
    if (prefix === 'D') return 4;
    if (prefix === 'E') return 5;
    if (prefix === 'F') return 6;
    if (prefix === 'G') return 7;
    if (prefix === 'H') return 8;
    
    return 1; // Default
  };

  const checkAndGenerateNextBout = (completedBout: string | number, winnerName: string, winnerClub: string, categoryName?: string) => {
    if (!currentEventId) return;

    const normHelper = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();

    // Resolve category helper
    const getMappingCategory = (m: any) => {
      if (m.categoryName && m.categoryName !== "Auto-Extracted" && m.categoryName !== "Auto-Extracted from File") {
        return m.categoryName;
      }
      const nextMatch = boutQueue.find(b => isBoutMatch(b.data.bout, m.nextBout)) ||
                        rings.flatMap(r => [r.currentBout, r.onDeck, r.inTheHole]).find(b => b && isBoutMatch(b.bout, m.nextBout));
      if (nextMatch) {
        return nextMatch.category || nextMatch.data?.category || '';
      }
      return '';
    };

    const compBoutHistObj = matchHistory.find(h => isBoutMatch(h.bout, completedBout) && h.eventId === currentEventId);
    const resolvedCat = categoryName || (compBoutHistObj ? compBoutHistObj.category : '');

    // 1. Find mappings where this bout is a source and categories match
    const relevantMappings = mappings.filter(m => {
      const boutsMatch = isBoutMatch(m.sourceBout, completedBout);
      if (!boutsMatch) return false;

      const mappingCategory = getMappingCategory(m);
      if (resolvedCat && mappingCategory) {
        return normHelper(mappingCategory) === normHelper(resolvedCat);
      }
      return true;
    });
    
    for (const mapping of relevantMappings) {
      const nextBoutId = mapping.nextBout;
      const targetCategory = getMappingCategory(mapping);
      
      // 2. Find the other mapping for the same nextBout within the same category
      const otherMapping = mappings.find(m => 
        isBoutMatch(m.nextBout, nextBoutId) && 
        m.id !== mapping.id &&
        normHelper(getMappingCategory(m)) === normHelper(targetCategory)
      );
      
      let blue_name = '';
      let blue_club = '';
      let red_name = '';
      let red_club = '';
      
      let shouldGenerate = false;

      if (mapping.slot === 'Chung') {
        blue_name = winnerName;
        blue_club = winnerClub;
      } else {
        red_name = winnerName;
        red_club = winnerClub;
      }

      if (otherMapping) {
        // Check if the other source bout has a winner under the same category
        const otherWinner = matchHistory.find(h => 
          isBoutMatch(h.bout, otherMapping.sourceBout) && 
          h.eventId === currentEventId &&
          normHelper(h.category) === normHelper(targetCategory)
        );
        if (otherWinner) {
          if (otherMapping.slot === 'Chung') {
            blue_name = otherWinner.winner;
            blue_club = otherWinner.winnerClub || '';
          } else {
            red_name = otherWinner.winner;
            red_club = otherWinner.winnerClub || '';
          }
          shouldGenerate = true;
        }
      } else {
        // Only one source bout, so the other player is already available (e.g. bye)
        shouldGenerate = true;
      }

      // Check if already in queue (with match on category name to avoid cross-category overwrites)
      const existingQueueIndex = boutQueue.findIndex(q => 
        isBoutMatch(q.data.bout, nextBoutId) && 
        q.data.eventId === currentEventId && 
        normHelper(q.data.category) === normHelper(targetCategory)
      );
      
      if (existingQueueIndex !== -1) {
        // Update existing bout in queue
        setBoutQueue(prev => {
          const updated = [...prev];
          const existing = updated[existingQueueIndex].data;
          updated[existingQueueIndex].data = {
            ...existing,
            blue_name: blue_name ? blue_name.toUpperCase() : existing.blue_name,
            blue_club: blue_club ? blue_club.toUpperCase() : existing.blue_club,
            red_name: red_name ? red_name.toUpperCase() : existing.red_name,
            red_club: red_club ? red_club.toUpperCase() : existing.red_club,
          };
          localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
          return updated;
        });
      }

      // Check and update if already in rings (with category validation)
      setRings(prevRings => {
        let ringsModified = false;
        const nextRings = prevRings.map(r => {
          let ringChanged = false;
          let updatedRing = { ...r };
          ['currentBout', 'onDeck', 'inTheHole'].forEach(slot => {
            const boutInSlot = updatedRing[slot as keyof RingStatus] as MatchData | null;
            if (boutInSlot && 
                isBoutMatch(boutInSlot.bout, nextBoutId) && 
                (boutInSlot.eventId === currentEventId || !boutInSlot.eventId) &&
                normHelper(boutInSlot.category) === normHelper(targetCategory)) {
              updatedRing = {
                ...updatedRing,
                [slot]: {
                  ...boutInSlot,
                  blue_name: blue_name ? blue_name.toUpperCase() : boutInSlot.blue_name,
                  blue_club: blue_club ? blue_club.toUpperCase() : boutInSlot.blue_club,
                  red_name: red_name ? red_name.toUpperCase() : boutInSlot.red_name,
                  red_club: red_club ? red_club.toUpperCase() : boutInSlot.red_club,
                }
              };
              ringChanged = true;
              ringsModified = true;
            }
          });
          return ringChanged ? updatedRing : r;
        });
        if (ringsModified) {
          localStorage.setItem('tkd_rings', JSON.stringify(nextRings));
          return nextRings;
        }
        return prevRings;
      });

      if (existingQueueIndex === -1 && shouldGenerate) {
        // Check if already in rings (check again because we might have just updated it above)
        const existsInRings = rings.some(r => (
          (r.currentBout && isBoutMatch(r.currentBout.bout, nextBoutId) && r.currentBout.eventId === currentEventId && normHelper(r.currentBout.category) === normHelper(targetCategory)) || 
          (r.onDeck && isBoutMatch(r.onDeck.bout, nextBoutId) && r.onDeck.eventId === currentEventId && normHelper(r.onDeck.category) === normHelper(targetCategory)) || 
          (r.inTheHole && isBoutMatch(r.inTheHole.bout, nextBoutId) && r.inTheHole.eventId === currentEventId && normHelper(r.inTheHole.category) === normHelper(targetCategory))
        ));

        if (!existsInRings) {
          // Generate the bout
          const ringNum = getRingFromBout(nextBoutId);
          const newMatch: MatchData = {
            ring: ringNum,
            bout: nextBoutId,
            blue_name: blue_name.toUpperCase(),
            blue_club: blue_club.toUpperCase(),
            red_name: red_name.toUpperCase(),
            red_club: red_club.toUpperCase(),
            category: targetCategory.toUpperCase(), 
            privacy_mode: false,
            eventId: currentEventId
          };
          
          setBoutQueue(prev => {
            const isDuplicate = prev.some(q => 
              isBoutMatch(q.data.bout, nextBoutId) && 
              q.data.eventId === currentEventId &&
              normHelper(q.data.category) === normHelper(targetCategory)
            );
            if (isDuplicate) return prev;
            const updated = [...prev, { id: `auto_${currentEventId}_${nextBoutId}_${Date.now()}`, data: newMatch }];
            localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
            return updated;
          });
        }
      }
    }
  };

  const handlePointsUpdateApp = async (ringNumber: number, boutNumber: string | number, newPoints: any) => {
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNumber);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    const ring = rings.find(r => r.ringNumber === ringNumber);
    const targetSyncRing = ring?.currentBout?.originalRing || ringNumber;

    setRings(prev => {
      const updated = prev.map(r => r.ringNumber === ringNumber && r.currentBout && isBoutMatch(r.currentBout.bout, boutNumber) ? { 
        ...r, 
        currentBout: { ...r.currentBout, points: newPoints }
      } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });

    if (googleSheetUrl && currentEventId) {
      updatePointsInGoogleSheets(googleSheetUrl, targetSyncRing, boutNumber, newPoints, getCurrentEventName());
    }
  };

  const handleBoutUpdate = async (ringNumber: number, newData: MatchData) => {
    const userRole = sessionStorage.getItem('user_role');
    const assignedRing = sessionStorage.getItem('assigned_ring');
    const targetRingLetter = String.fromCharCode(64 + ringNumber);
    // Court Clerk has same authority as admin (unrestricted ring access)
    if (false && userRole === 'court_clerk' && assignedRing !== targetRingLetter) {
        alert("You are not authorized to modify this ring.");
        return;
    }

    // Capitalize all letters for ring controller and normalize bout number
    const capitalizedData: MatchData = {
      ...newData,
      eventId: newData.eventId || currentEventId || null,
      blue_name: newData.blue_name?.toUpperCase() || '',
      blue_club: newData.blue_club?.toUpperCase() || '',
      red_name: newData.red_name?.toUpperCase() || '',
      red_club: newData.red_club?.toUpperCase() || '',
      category: newData.category?.toUpperCase() || '',
      bout: normalizeBoutWithRing(newData.bout, ringNumber, newData.originalRing),
    };

    // Update categories and clubs lists
    if (capitalizedData.category && !categories.includes(capitalizedData.category)) {
      const newCats = [...categories, capitalizedData.category];
      setCategories(newCats);
      localStorage.setItem('tkd_categories', JSON.stringify(newCats));
    }
    if (capitalizedData.blue_club && !clubs.includes(capitalizedData.blue_club)) {
      const newClubs = [...clubs, capitalizedData.blue_club];
      setClubs(newClubs);
      localStorage.setItem('tkd_clubs', JSON.stringify(newClubs));
    }
    if (capitalizedData.red_club && !clubs.includes(capitalizedData.red_club)) {
      const newClubs = [...clubs, capitalizedData.red_club];
      setClubs(newClubs);
      localStorage.setItem('tkd_clubs', JSON.stringify(newClubs));
    }

    // Update rings state IMMEDIATELY for real-time sync
    setRings(prev => {
      const updated = prev.map(r => r.ringNumber === ringNumber ? { 
        ...r, 
        currentBout: capitalizedData,
        nextBoutNumber: getBoutNumber(capitalizedData.bout) + 1
      } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });

    // Auto sync to Google Sheets
    let activeUrl = googleSheetUrl;
    if (!activeUrl && currentEventId && events.length > 0) {
      const event = events.find(e => e.id === currentEventId);
      if (event && event.sheetUrl) {
        activeUrl = event.sheetUrl;
        setGoogleSheetUrl(activeUrl);
      }
    }

    if (activeUrl) {
      setIsSyncing(true);
      try {
        const dataToSync = { ...capitalizedData, ring: capitalizedData.originalRing || capitalizedData.ring };
        await syncToGoogleSheets(activeUrl, dataToSync, getCurrentEventName());
      } catch (e) {
        console.error('Sync error:', e);
      } finally {
        setIsSyncing(false);
      }
    }
  };

  const suspendActiveBout = (ringNumber: number) => {
    const ring = rings.find(r => r.ringNumber === ringNumber);
    const currentBout = ring?.currentBout;
    if (!currentBout) return;

    setRings(prev => {
      const updated = prev.map(r => {
        if (r.ringNumber === ringNumber) {
          const suspended = r.suspendedBouts ? [...r.suspendedBouts] : [];
          if (!suspended.some(b => isBoutMatch(b.bout, currentBout.bout))) {
            suspended.push({ ...currentBout, eventId: currentEventId || null });
          }
          return {
            ...r,
            currentBout: null,
            suspendedBouts: suspended
          };
        }
        return r;
      });
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });
  };

  const resumeSuspendedBout = (ringNumber: number, boutNumber: string | number) => {
    setRings(prev => {
      const updated = prev.map(r => {
        if (r.ringNumber === ringNumber) {
          const suspended = r.suspendedBouts ? [...r.suspendedBouts] : [];
          const targetIndex = suspended.findIndex(b => isBoutMatch(b.bout, boutNumber));
          if (targetIndex === -1) return r;

          const boutToResume = suspended[targetIndex];
          const nextSuspended = suspended.filter((_, idx) => idx !== targetIndex);

          // If there is currently an active match that is not complete and has players, suspend IT first!
          const activeBout = r.currentBout;
          if (activeBout && hasPlayers(activeBout)) {
            if (!nextSuspended.some(b => isBoutMatch(b.bout, activeBout.bout))) {
              nextSuspended.push({ ...activeBout, eventId: currentEventId || null });
            }
          }

          const resumedBoutNo = getBoutNumber(boutToResume.bout);
          return {
            ...r,
            currentBout: boutToResume,
            suspendedBouts: nextSuspended,
            nextBoutNumber: resumedBoutNo > 0 ? resumedBoutNo + 1 : r.nextBoutNumber
          };
        }
        return r;
      });
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });
  };

  const removeSuspendedBout = (ringNumber: number, boutNumber: string | number) => {
    setRings(prev => {
      const updated = prev.map(r => {
        if (r.ringNumber === ringNumber) {
          const suspended = r.suspendedBouts ? r.suspendedBouts.filter(b => !isBoutMatch(b.bout, boutNumber)) : [];
          return {
            ...r,
            suspendedBouts: suspended
          };
        }
        return r;
      });
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });
  };

  const returnActiveBoutToQueue = (ringNumber: number) => {
    const ring = rings.find(r => r.ringNumber === ringNumber);
    const currentBout = ring?.currentBout;
    if (!currentBout) return;

    // Add back to the upcoming queue (boutQueue)
    const queueItem = { 
      id: Math.random().toString(36).substr(2, 9), 
      data: { ...currentBout, eventId: currentEventId || null } 
    };

    setBoutQueue(prev => {
      const updated = [queueItem, ...prev];
      localStorage.setItem('tkd_bout_queue', JSON.stringify(updated));
      return updated;
    });

    // Remove from ring currentBout slot
    setRings(prev => {
      const updated = prev.map(r => {
        if (r.ringNumber === ringNumber) {
          const returnedBoutNo = getBoutNumber(currentBout.bout);
          return {
            ...r,
            currentBout: null,
            nextBoutNumber: returnedBoutNo > 0 ? returnedBoutNo : r.nextBoutNumber
          };
        }
        return r;
      });
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });
  };

  const startRing = (ringNumber: number) => {
    const ring = rings.find(r => r.ringNumber === ringNumber);
    const nextBoutIndex = boutQueue.findIndex(q => q.data.ring === ringNumber && (!q.data.eventId || q.data.eventId === currentEventId));
    
    // Reset final bouts flag when starting a new session
    setRings(prev => {
      const updated = prev.map(r => r.ringNumber === ringNumber ? { ...r, isFinalBouts: false } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });

    if (nextBoutIndex !== -1) {
      pullBout(boutQueue[nextBoutIndex].id);
    } else if (ring && ring.totalBouts) {
      // If queue is empty but we have total bouts, show the missing bout prompt
      const expectedBout = ring.nextBoutNumber || 1;
      if (expectedBout <= ring.totalBouts) {
        setMissingBoutPrompt({ ringNumber, expectedBout, totalBouts: ring.totalBouts });
      }
    } else {
      const defaultMatch: MatchData = {
        ring: ringNumber,
        bout: ring?.nextBoutNumber || 1,
        blue_name: "",
        blue_club: "",
        red_name: "",
        red_club: "",
        category: "",
        privacy_mode: false
      };
      handleBoutUpdate(ringNumber, defaultMatch);
    }
  };

  const addRing = (ringNumber: number) => {
    setRings(prev => {
      const existingIndex = prev.findIndex(r => r.ringNumber === ringNumber);
      if (existingIndex >= 0) {
        if (prev[existingIndex].isDeleted) {
          const updated = prev.map(r => r.ringNumber === ringNumber ? { 
            ...r, 
            isDeleted: false,
            currentBout: null,
            onDeck: null,
            inTheHole: null,
            nextBoutNumber: 1 
          } : r);
          localStorage.setItem('tkd_rings', JSON.stringify(updated));
          return updated;
        }
        return prev;
      }
      const newRing: RingStatus = {
        ringNumber: ringNumber,
        currentBout: null,
        onDeck: null,
        inTheHole: null,
        nextBoutNumber: 1
      };
      const next = [...prev, newRing].sort((a, b) => a.ringNumber - b.ringNumber);
      localStorage.setItem('tkd_rings', JSON.stringify(next));
      return next;
    });
  };

  const deleteRing = (ringNumber: number) => {
    setRings(prev => {
      const next = prev.map(r => r.ringNumber === ringNumber ? { ...r, isDeleted: true } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(next));
      return next;
    });
  };

  const handleUpdateTotalBouts = (ringNumber: number, total: number) => {
    setRings(prev => {
      const ring = prev.find(r => r.ringNumber === ringNumber);
      if (ring) {
        const isSessionInProgress = ring.nextBoutNumber && ring.nextBoutNumber > 1 && ring.totalBouts && ring.nextBoutNumber <= ring.totalBouts;
        if (isSessionInProgress) return prev;
      }
      const updated = prev.map(r => r.ringNumber === ringNumber ? { ...r, totalBouts: total, isFinalBouts: false } : r);
      localStorage.setItem('tkd_rings', JSON.stringify(updated));
      return updated;
    });
  };

  const ringMapping: Record<string, string> = {
    "ring1": "A", "ring2": "B", "ring3": "C", "ring4": "D",
    "ring5": "E", "ring6": "F", "ring7": "G", "ring8": "H",
    "ring9": "I", "ring10": "J", "ring11": "K", "ring12": "L"
  };

  const handleLogin = (username: string, pass: string, eventId?: string) => {
    const found = accounts.find(a => a.username === username && a.password === pass);
    if (found) {
      if (ringMapping[username]) {
        sessionStorage.setItem('assigned_ring', ringMapping[username]);
        sessionStorage.setItem('user_role', 'court_clerk');
      }
      
      setUser(found);
      localStorage.setItem('tkd_user', JSON.stringify(found));
      localStorage.setItem('tkd_login_time', new Date().getTime().toString());
      if (eventId) {
        setCurrentEventId(eventId);
        localStorage.setItem('tkd_current_event_v3', eventId);
        const event = events.find(e => e.id === eventId);
        if (event && event.sheetUrl) {
          setGoogleSheetUrl(event.sheetUrl);
          localStorage.setItem('tkd_sheet_url', event.sheetUrl);
        }
      }
      
      if (found.role === 'viewer') {
        setActiveTab('general');
      } else if (found.role === 'user' || sessionStorage.getItem('user_role') === 'court_clerk') {
        setActiveTab('mats');
      } else if (found.role === 'report') {
        setActiveTab('report');
      } else if (found.role === 'ta') {
        setActiveTab('ta-sheet');
      } else {
        setActiveTab('dashboard');
      }
      
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (isStrictPublic) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Secret shortcut: Ctrl + Shift + L to show login
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        if (!user) setShowLogin(true);
        else setIsPublicView(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [user, isStrictPublic]);

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('tkd_user');
    localStorage.removeItem('tkd_login_time');
    setShowLogin(true);
  };

  const handleAddEvent = (newEvent: EventData) => {
    const updated = [...events, newEvent];
    setEvents(updated);
    localStorage.setItem('tkd_events_v3', JSON.stringify(updated));
    
    // Also auto-generate rings up to ringQuantity if they don't exist
    // For simplicity, we just set the rings to the new quantity
    const newRings = Array.from({ length: newEvent.ringQuantity }, (_, i) => ({
      ringNumber: i + 1,
      currentBout: null,
      onDeck: null,
      inTheHole: null
    }));
    setRings(newRings);
    localStorage.setItem('tkd_rings', JSON.stringify(newRings));
  };

  const handleUpdateEvent = (updatedEvent: EventData) => {
    const updated = events.map(e => e.id === updatedEvent.id ? updatedEvent : e);
    setEvents(updated);
    localStorage.setItem('tkd_events_v3', JSON.stringify(updated));
    
    // If the updated event is currently selected, also update googleSheetUrl in real-time
    if (updatedEvent.id === currentEventId) {
      setGoogleSheetUrl(updatedEvent.sheetUrl);
      localStorage.setItem('tkd_sheet_url', updatedEvent.sheetUrl);
    }
  };

  const handleDeleteEvent = (id: string) => {
    const updated = events.filter(e => e.id !== id);
    setEvents(updated);
    localStorage.setItem('tkd_events_v3', JSON.stringify(updated));
    
    if (updated.length === 0) {
      setBoutQueue([]);
      localStorage.removeItem('tkd_bout_queue');
      setMatchHistory([]);
      localStorage.removeItem('tkd_match_history');
      setMappings([]);
      localStorage.removeItem('tkd_bout_mappings');
      setCurrentEventId(null);
      localStorage.removeItem('tkd_current_event_v3');
      const clearedRings = Array.from({ length: 12 }, (_, i) => ({
        ringNumber: i + 1,
        currentBout: null,
        onDeck: null,
        inTheHole: null
      }));
      setRings(clearedRings);
      localStorage.setItem('tkd_rings', JSON.stringify(clearedRings));
    } else {
      // Remove related bout queue
      const updatedQueue = boutQueue.filter(b => b.data.eventId !== id);
      setBoutQueue(updatedQueue);
      localStorage.setItem('tkd_bout_queue', JSON.stringify(updatedQueue));

      // Remove related match history
      const updatedHistory = matchHistory.filter(h => h.eventId !== id);
      setMatchHistory(updatedHistory);
      localStorage.setItem('tkd_match_history', JSON.stringify(updatedHistory));

      // Remove related bout mappings
      const updatedMappings = mappings.filter(m => m.eventId !== id);
      setMappings(updatedMappings);
      localStorage.setItem('tkd_bout_mappings', JSON.stringify(updatedMappings));

      if (currentEventId === id) {
        setCurrentEventId(null);
        localStorage.removeItem('tkd_current_event_v3');
        // Clear rings if current event is deleted
        const clearedRings = Array.from({ length: 12 }, (_, i) => ({
          ringNumber: i + 1,
          currentBout: null,
          onDeck: null,
          inTheHole: null
        }));
        setRings(clearedRings);
        localStorage.setItem('tkd_rings', JSON.stringify(clearedRings));
      }
    }
  };

  const handleAddAccount = (newAcc: UserAccount) => {
    const updated = [...accounts, newAcc];
    setAccounts(updated);
    localStorage.setItem('tkd_accounts', JSON.stringify(updated));
  };

  const handleDeleteAccount = (username: string) => {
    if (username === 'admin') return; // Protect main admin
    const updated = accounts.filter(a => a.username !== username);
    setAccounts(updated);
    localStorage.setItem('tkd_accounts', JSON.stringify(updated));
    if (user?.username === username) {
      handleLogout();
    }
  };

  const handleEditPassword = (username: string, newPassword: string) => {
    const updated = accounts.map(a => a.username === username ? { ...a, password: newPassword } : a);
    setAccounts(updated);
    localStorage.setItem('tkd_accounts', JSON.stringify(updated));
  };

  const currentBoutQueue = React.useMemo(() => {
    if (!currentEventId || events.length === 0) return [];
    return boutQueue.filter(b => !b.data.eventId || b.data.eventId === currentEventId);
  }, [boutQueue, currentEventId, events.length]);

  const currentRings = React.useMemo(() => {
    const nonDeleted = rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount);
    if (!currentEventId || events.length === 0) {
      return nonDeleted.map(r => ({ ...r, currentBout: null, onDeck: null, inTheHole: null }));
    }
    return nonDeleted.map(r => ({
      ...r,
      currentBout: r.currentBout && (!r.currentBout.eventId || r.currentBout.eventId === currentEventId) ? r.currentBout : null,
      onDeck: r.onDeck && (!r.onDeck.eventId || r.onDeck.eventId === currentEventId) ? r.onDeck : null,
      inTheHole: r.inTheHole && (!r.inTheHole.eventId || r.inTheHole.eventId === currentEventId) ? r.inTheHole : null,
    }));
  }, [rings, currentEventId, visibleRingsCount, events.length]);

  const effectivePublicEventId = React.useMemo(() => {
    if (events.length === 0) return null;
    if (publicEventId === 'active') {
      return currentEventId;
    }
    return publicEventId || currentEventId;
  }, [publicEventId, currentEventId, events.length]);

  const publicBoutQueue = React.useMemo(() => {
    if (!effectivePublicEventId || events.length === 0) return [];
    return boutQueue.filter(b => !b.data.eventId || b.data.eventId === effectivePublicEventId);
  }, [boutQueue, effectivePublicEventId, events.length]);

  const publicRings = React.useMemo(() => {
    const nonDeleted = rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount);
    if (!effectivePublicEventId || events.length === 0) {
      return nonDeleted.map(r => ({ ...r, currentBout: null, onDeck: null, inTheHole: null }));
    }
    return nonDeleted.map(r => ({
      ...r,
      currentBout: r.currentBout && (!r.currentBout.eventId || r.currentBout.eventId === effectivePublicEventId) ? r.currentBout : null,
      onDeck: r.onDeck && (!r.onDeck.eventId || r.onDeck.eventId === effectivePublicEventId) ? r.onDeck : null,
      inTheHole: r.inTheHole && (!r.inTheHole.eventId || r.inTheHole.eventId === effectivePublicEventId) ? r.inTheHole : null,
    }));
  }, [rings, effectivePublicEventId, visibleRingsCount, events.length]);

  const publicEventName = React.useMemo(() => {
    if (!effectivePublicEventId) return '';
    const event = events.find(e => e.id === effectivePublicEventId);
    return event ? event.name : '';
  }, [events, effectivePublicEventId]);

  if (!user && showLogin && !isPublicView && !isStrictPublic) {
    return <LoginScreen onLogin={handleLogin} events={events} onBack={() => setShowLogin(false)} />;
  }

  if (!user) {
    return (
      <PublicDashboardView 
        rings={publicRings} 
        boutQueue={publicBoutQueue} 
        namingMode={ringNamingMode} 
        onBack={() => setShowLogin(true)} 
        isSpectator={true}
        showTotalBouts={showTotalBoutsPublic}
        boutNumberingMode={boutNumberingMode}
        showOnlyActiveRings={showOnlyActiveRings}
        showEmptyBoutAsInactive={showEmptyBoutAsInactive}
        showPublicStandbyQueue={showPublicStandbyQueue}
        publicViewLayout={publicViewLayout}
        selectedEventName={publicEventName}
        boutTransfers={boutTransfers}
        isAdmin={false}
        onDeleteTransfer={handleCancelTransferPin}
      />
    );
  }

  if (isPublicView) {
    return (
      <PublicDashboardView 
        rings={publicRings} 
        boutQueue={publicBoutQueue} 
        namingMode={ringNamingMode} 
        onBack={() => setIsPublicView(false)} 
        showTotalBouts={showTotalBoutsPublic}
        boutNumberingMode={boutNumberingMode}
        showOnlyActiveRings={showOnlyActiveRings}
        showEmptyBoutAsInactive={showEmptyBoutAsInactive}
        showPublicStandbyQueue={showPublicStandbyQueue}
        publicViewLayout={publicViewLayout}
        selectedEventName={publicEventName}
        boutTransfers={boutTransfers}
        isAdmin={user?.role === 'admin'}
        onDeleteTransfer={handleCancelTransferPin}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col md:flex-row text-slate-900 font-sans">
      {/* Mobile Header */}
      <header className="md:hidden bg-white border-b border-slate-200 p-4 flex items-center justify-between sticky top-0 z-[60] print:hidden">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-red-200">
            <Trophy size={18} />
          </div>
          <h1 className="font-bold text-base leading-tight">MY-TKD</h1>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={handleLogout}
            className="p-2 text-slate-400 hover:text-red-600 transition-colors"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      {/* Sidebar (Desktop) */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col hidden md:flex h-screen sticky top-0 print:hidden">
        <div className="p-6 flex items-center gap-3 border-b border-slate-100">
          <div className="w-10 h-10 bg-red-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-red-200">
            <Trophy size={24} />
          </div>
          <div>
            <h1 className="font-black text-lg leading-tight tracking-tighter">MY-TKD</h1>
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">Tournament Manager</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {user?.role === 'admin' && (
            <>
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Dashboard" 
                active={activeTab === 'dashboard'} 
                onClick={() => setActiveTab('dashboard')} 
              />
              <NavItem 
                icon={<Monitor size={20} />} 
                label="Onsite View" 
                active={activeTab === 'general'} 
                onClick={() => setActiveTab('general')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Standby View" 
                active={activeTab === 'standby'} 
                onClick={() => setActiveTab('standby')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Site VIew" 
                active={activeTab === 'site_view'} 
                onClick={() => setActiveTab('site_view')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Point View" 
                active={activeTab === 'points'} 
                onClick={() => setActiveTab('points')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Live Controller" 
                active={activeTab === 'mats'} 
                onClick={() => setActiveTab('mats')} 
              />
              <NavItem 
                icon={<Shield size={20} />} 
                label="Bracket Logic" 
                active={activeTab === 'mapping'} 
                onClick={() => setActiveTab('mapping')} 
              />
              <NavItem 
                icon={<RefreshCw size={20} />} 
                label="AI Setup" 
                active={activeTab === 'ai-setup'} 
                onClick={() => setActiveTab('ai-setup')} 
              />
              <NavItem 
                icon={<Layers size={20} />} 
                label="Bout Chart" 
                active={activeTab === 'bout-chart'} 
                onClick={() => setActiveTab('bout-chart')} 
              />
              <NavItem 
                icon={<Search size={20} />} 
                label="Search Winner" 
                active={activeTab === 'search-winner'} 
                onClick={() => setActiveTab('search-winner')} 
              />
            </>
          )}
          {user?.role === 'user' && (
            <>
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label={`Ring ${getRingName(Number(user?.assignedRing) || 1)}`} 
                active={activeTab === 'mats'} 
                onClick={() => setActiveTab('mats')} 
                badge={rings.find(r => r.ringNumber === Number(user?.assignedRing))?.totalBouts || 0}
              />
              <NavItem 
                icon={<Search size={20} />} 
                label="Search Winner" 
                active={activeTab === 'search-winner'} 
                onClick={() => setActiveTab('search-winner')} 
              />
            </>
          )}
          {user?.role === 'viewer' && (
            <>
              <NavItem 
                icon={<Monitor size={20} />} 
                label="Onsite View" 
                active={activeTab === 'general'} 
                onClick={() => setActiveTab('general')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Standby View" 
                active={activeTab === 'standby'} 
                onClick={() => setActiveTab('standby')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Site VIew" 
                active={activeTab === 'site_view'} 
                onClick={() => setActiveTab('site_view')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Point View" 
                active={activeTab === 'points'} 
                onClick={() => setActiveTab('points')} 
              />
              <NavItem 
                icon={<QrCode size={20} />} 
                label="Public View" 
                onClick={() => setIsPublicView(true)} 
              />
            </>
          )}
          {user?.role === 'ta' && (
            <>
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Standby View" 
                active={activeTab === 'standby'} 
                onClick={() => setActiveTab('standby')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="Site VIew" 
                active={activeTab === 'site_view'} 
                onClick={() => setActiveTab('site_view')} 
              />
              <NavItem 
                icon={<LayoutDashboard size={20} />} 
                label="TA Sheet" 
                active={activeTab === 'ta-sheet'} 
                onClick={() => setActiveTab('ta-sheet')} 
              />
              <NavItem 
                icon={<Edit2 size={20} />} 
                label="Player Inspection" 
                active={activeTab === 'player-signature'} 
                onClick={() => setActiveTab('player-signature')} 
              />
              <NavItem 
                icon={<ClipboardCheck size={20} />} 
                label="Inspection Logs" 
                active={activeTab === 'inspection-logs'} 
                onClick={() => setActiveTab('inspection-logs')} 
              />
              <NavItem 
                icon={<Search size={20} />} 
                label="Search Winner" 
                active={activeTab === 'search-winner'} 
                onClick={() => setActiveTab('search-winner')} 
              />
            </>
          )}
          {user?.role === 'report' && (
            <NavItem 
              icon={<Trophy size={20} />} 
              label="Tournament Report" 
              active={activeTab === 'report'} 
              onClick={() => setActiveTab('report')} 
            />
          )}
          {user?.role === 'admin' && (
            <>
              <NavItem 
                icon={<Trophy size={20} />} 
                label="Tournament Report" 
                active={activeTab === 'report'} 
                onClick={() => setActiveTab('report')} 
              />

              <NavItem 
                icon={<ClipboardCheck size={20} />} 
                label="Inspection Logs" 
                active={activeTab === 'inspection-logs'} 
                onClick={() => setActiveTab('inspection-logs')} 
              />
              <NavItem 
                icon={<QrCode size={20} />} 
                label="Public View" 
                onClick={() => setIsPublicView(true)} 
              />
            </>
          )}
        </nav>

        <div className="p-4 border-t border-slate-100 space-y-2">
          <div className="px-4 py-2 bg-slate-50 rounded-xl flex items-center gap-3">
            <div className="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-slate-600 font-bold text-xs flex-shrink-0">
              {user?.username.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-slate-800 truncate">{user?.username}</p>
              <p className="text-[10px] text-slate-500 uppercase font-black">{user?.role}</p>
            </div>
            <button 
              onClick={handleLogout}
              className="p-1.5 hover:bg-red-50 text-slate-400 hover:text-red-500 rounded-lg transition-colors flex-shrink-0"
              title="Logout"
            >
              <LogOut size={16} />
            </button>
          </div>
          {user?.role === 'admin' && (
            <button 
              onClick={() => setActiveTab('settings')}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-bold transition-all group",
                activeTab === 'settings' 
                  ? "bg-red-50 text-red-600" 
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              )}
            >
              <Settings size={20} className="group-hover:rotate-45 transition-transform duration-300" />
              Settings
            </button>
          )}
        </div>

        <div className="p-4 border-t border-slate-100">
          <div className="bg-slate-50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className={cn(
                "w-2 h-2 rounded-full",
                googleSheetUrl ? "bg-green-500 animate-pulse" : "bg-slate-300"
              )} />
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Live Sync</span>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              {googleSheetUrl ? (
                <>
                  {user?.role === 'admin' ? 'Connected to Google Sheets:' : 'Connected to System'} <br/>
                  <span className="text-slate-600 truncate block">Active Web App</span>
                </>
              ) : (
                <>
                  {user?.role === 'admin' ? 'Google Sheets:' : 'System Status:'} <br/>
                  <span className="text-red-400 font-bold">Not Configured</span>
                </>
              )}
            </p>
            {lastSyncError && (
              <div className="mt-2 p-2 bg-red-50 border border-red-100 rounded-lg">
                <p className="text-[9px] font-bold text-red-600 leading-tight">
                  {lastSyncError}
                </p>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col md:h-screen overflow-hidden">
        {isQuotaExceeded && (
          <div className="bg-gradient-to-r from-red-600 to-amber-600 text-white px-4 py-2.5 text-center text-xs font-bold flex flex-col sm:flex-row items-center justify-center gap-2 relative z-50 border-b border-red-700 shadow-md">
            <div className="flex items-center gap-2 justify-center">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 animate-bounce text-amber-200" />
              <span>
                <strong>Firestore Daily Quota Exceeded!</strong> Real-time cloud sync is paused; all operator actions remain fully active locally (offline-first backup mode) and will automatically upload when the quota resets tomorrow.
              </span>
            </div>
            <div className="flex gap-3 items-center justify-center shrink-0 mt-1 sm:mt-0">
              <a 
                href="https://console.firebase.google.com/project/vocal-vigil-452005-p0/firestore/databases/ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849/data?openUpgradeDialog=true" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="bg-white text-red-700 px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider"
              >
                Upgrade / Check Quota
              </a>
              <button 
                onClick={() => setIsQuotaExceeded(false)}
                className="text-white hover:text-slate-200 underline text-[10px] font-mono py-0.5"
              >
                [Dismiss]
              </button>
            </div>
          </div>
        )}

        {/* Scrollable Area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 md:space-y-8 pb-24 md:pb-8">
          {/* Page Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 md:mb-8 print:hidden">
            <div className="flex items-center gap-4">
              <h2 className="text-xl md:text-2xl font-black text-slate-900 capitalize tracking-tight">{activeTab}</h2>
            </div>
            
            <div className="flex flex-wrap items-center gap-2 md:gap-4">
              {events.length > 0 && user?.role === 'admin' ? (
                <div className="flex items-center gap-2">
                  <div className={cn("w-1.5 h-1.5 rounded-full", currentEventId ? "bg-green-500 animate-pulse" : "bg-slate-300")} />
                  <select
                    value={currentEventId || ''}
                    onChange={(e) => {
                      const id = e.target.value;
                      if (!id) {
                        setCurrentEventId(null);
                        localStorage.removeItem('tkd_current_event_v3');
                        return;
                      }
                      setCurrentEventId(id);
                      localStorage.setItem('tkd_current_event_v3', id);
                      const event = events.find(ev => ev.id === id);
                      if (event && event.sheetUrl) {
                        setGoogleSheetUrl(event.sheetUrl);
                        localStorage.setItem('tkd_sheet_url', event.sheetUrl);
                      }
                    }}
                    className="px-4 py-2 bg-slate-100 rounded-xl text-[10px] md:text-xs font-black text-slate-600 border border-slate-200 uppercase tracking-widest focus:ring-2 focus:ring-red-500 outline-none"
                  >
                    <option value="">Select Tournament Event...</option>
                    {events.map((e, i) => (
                      <option key={`${e.id}-${i}`} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </div>
              ) : events.length > 0 && currentEventId ? (
                <div className="px-4 py-2 bg-slate-100 rounded-xl text-[10px] md:text-xs font-black text-slate-600 border border-slate-200 uppercase tracking-widest flex items-center gap-2">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                  Event: {events.find(e => e.id === currentEventId)?.name || 'Unknown Event'}
                </div>
              ) : null}
              <div className="flex flex-col items-end gap-2 w-full sm:w-auto">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button 
                    onClick={() => setShowAnnouncementInput(true)}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 md:px-6 py-2 md:py-2.5 bg-red-600 text-white rounded-xl text-[10px] md:text-sm font-black uppercase tracking-widest hover:bg-red-700 transition-all shadow-lg shadow-red-200"
                  >
                    <Bell size={16} />
                    <span>Broadcast</span>
                  </button>
                  <button 
                    onClick={() => setShowEditBoutDetailsModal(true)}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 md:px-6 py-2 md:py-2.5 bg-indigo-600 text-white rounded-xl text-[10px] md:text-sm font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
                  >
                    <Edit2 size={16} />
                    <span className="hidden md:inline">Edit Details</span>
                    <span className="md:hidden">Details</span>
                  </button>
                  {user?.role !== 'ta' && (
                    <>
                      <button 
                        onClick={() => setShowEditResultModal(true)}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 md:px-6 py-2 md:py-2.5 bg-blue-600 text-white rounded-xl text-[10px] md:text-sm font-black uppercase tracking-widest hover:bg-blue-700 transition-all shadow-lg shadow-blue-200"
                      >
                        <Edit2 size={16} />
                        <span className="hidden md:inline">Edit Result</span>
                        <span className="md:hidden">Result</span>
                      </button>
                      <button 
                        onClick={() => setShowNewBoutModal(true)}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 md:px-6 py-2 md:py-2.5 bg-slate-900 text-white rounded-xl text-[10px] md:text-sm font-black uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg shadow-slate-200"
                      >
                        <Plus size={16} />
                        <span>New</span>
                      </button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                </div>
              </div>
            </div>
          </div>

          {activeTab === 'dashboard' && (() => {
            const nonDeletedRings = rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount);
            const activeCount = nonDeletedRings.filter(r => r.currentBout).length;
            const selectedRingObj = nonDeletedRings.find(r => r.ringNumber === dashboardSelectedRing) || nonDeletedRings[0] || rings[0];
            const activeDashboardSelectedRing = selectedRingObj ? selectedRingObj.ringNumber : dashboardSelectedRing;

            return (
              <>
                {user?.role === 'admin' && (
                  <div className="bg-white border border-slate-200 rounded-3xl p-5 mb-6 shadow-sm">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                      <div>
                        <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                          <Database size={20} className="text-amber-600" />
                          Backup Mapping Recovery
                        </h3>
                        <p className="text-xs text-slate-500 mt-0.5">Click a ring to recover and review its previous bracket logic in AI Setup.</p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-2 px-2 scrollbar-none flex-nowrap lg:flex-wrap">
                      {nonDeletedRings.map((ringObj) => {
                        const ringNum = ringObj.ringNumber;
                        const groupKey = `${currentEventId}_${ringNum}`;
                        const hasBackup = backupData && backupData[groupKey] && backupData[groupKey].mappings && backupData[groupKey].mappings.length > 0;
                        
                        return (
                          <button
                            key={ringNum}
                            type="button"
                            disabled={isSyncing}
                            onClick={async () => {
                              if (!currentEventId) return;
                              const toLoad = backupData[groupKey] || { mappings: [], matches: [] };
                              if (toLoad.mappings.length === 0) {
                                alert("No backup mappings found for this ring.");
                                return;
                              }
                              setBackupToLoad(toLoad);
                              setActiveTab('ai-setup');
                            }}
                            className={cn(
                              "flex-1 min-w-[70px] h-12 flex flex-col items-center justify-center rounded-2xl border text-xs font-black transition-all duration-200 shadow-sm relative",
                              hasBackup 
                                ? "bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                                : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100 flex"
                            )}
                          >
                            <span className="text-[9px] opacity-75 font-bold leading-none uppercase">Ring</span>
                            <span className="text-base font-black leading-tight mt-0.5">{ringNamingMode === 'alphabet' ? String.fromCharCode(64 + ringNum) : ringNum}</span>
                            {hasBackup && (
                              <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-amber-500 border border-white" title="Backup Available" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Ring 1 to 12 Selection Bar on Top */}
                <div className="bg-white border border-slate-200 rounded-3xl p-5 mb-6 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                    <div>
                      <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                        <LayoutDashboard size={20} className="text-red-600" />
                        Active Ring Selection
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">Select a ring below to view and manage its active bout and upcoming queue.</p>
                    </div>
                    <div className="flex items-center gap-2 self-start sm:self-center">
                      <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-xs font-bold text-green-600 bg-green-50 px-3 py-1 rounded-full uppercase tracking-widest">
                        {activeCount} active ring{activeCount !== 1 ? 's' : ''} live
                      </span>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-2 px-2 scrollbar-none flex-nowrap lg:flex-wrap">
                    {nonDeletedRings.map((ringObj) => {
                      const ringNum = ringObj.ringNumber;
                      const isRingActive = !!ringObj.currentBout;
                      const isSelected = activeDashboardSelectedRing === ringNum;
                      
                      return (
                        <button
                          key={ringNum}
                          type="button"
                          id={`dashboard-ring-tab-${ringNum}`}
                          onClick={() => setDashboardSelectedRing(ringNum)}
                          className={cn(
                            "flex-1 min-w-[70px] h-12 flex flex-col items-center justify-center rounded-2xl border text-xs font-black transition-all duration-200 shadow-sm outline-none px-2 relative cursor-pointer",
                            isSelected
                              ? "bg-slate-900 border-slate-900 text-white ring-2 ring-offset-2 ring-slate-900"
                              : "bg-white border-slate-200 text-slate-700 hover:bg-slate-100"
                          )}
                        >
                          <span className="text-[9px] opacity-75 font-bold leading-none uppercase">Ring</span>
                          <span className="text-base font-black leading-tight mt-0.5">{getRingName(ringNum)}</span>
                          {isRingActive && (
                            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-green-500 border border-white flex items-center justify-center animate-pulse" title="Ongoing Bout" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                  {/* Live Rings */}
                  <div className="lg:col-span-2 space-y-6">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                        <LayoutDashboard size={20} className="text-red-600" />
                        Active Ring Overview (Ring {getRingName(activeDashboardSelectedRing)})
                      </h3>
                      <div className="flex items-center gap-2">
                        {selectedRingObj.currentBout ? (
                          <>
                            <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-xs font-bold text-green-600 uppercase tracking-widest">
                              Live
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="flex h-2 w-2 rounded-full bg-slate-300" />
                            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                              Inactive
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-1 gap-6">
                      <RingCard 
                        key={selectedRingObj.ringNumber} 
                        ring={selectedRingObj} 
                        namingMode={ringNamingMode}
                        categories={categories}
                        clubs={clubs}
                        queueCount={getFilteredQueue(selectedRingObj.ringNumber).length}
                        onUpdate={(data) => handleBoutUpdate(selectedRingObj.ringNumber, data)}
                        onPointsUpdate={(points) => handlePointsUpdateApp(selectedRingObj.ringNumber, selectedRingObj.currentBout?.bout || '', points)}
                        onUpdateTotalBouts={(total) => handleUpdateTotalBouts(selectedRingObj.ringNumber, total)}
                        onStart={() => startRing(selectedRingObj.ringNumber)}
                        onDelete={user?.role === 'admin' ? () => deleteRing(selectedRingObj.ringNumber) : undefined}
                        onWinnerSelect={(winner) => handleWinnerSelect(selectedRingObj.ringNumber, selectedRingObj.currentBout?.bout || 0, winner)}
                        currentEventId={currentEventId}
                        onForceSync={handleForceSync}
                        isAutoPull={autoPullRings[selectedRingObj.ringNumber] || false}
                        onToggleAutoPull={() => setAutoPullRings(prev => ({ ...prev, [selectedRingObj.ringNumber]: !prev[selectedRingObj.ringNumber] }))}
                        user={user}
                        boutNumberingMode={boutNumberingMode}
                        layout={ringControlLayout}
                        showInspectionPopupSetting={showInspectionPopupSetting}
                        onReturnToQueue={() => returnActiveBoutToQueue(selectedRingObj.ringNumber)}
                        onResumeSuspended={(boutNum) => resumeSuspendedBout(selectedRingObj.ringNumber, boutNum)}
                        onRemoveSuspended={(boutNum) => removeSuspendedBout(selectedRingObj.ringNumber, boutNum)}
                        onSuspendCurrentBout={() => suspendActiveBout(selectedRingObj.ringNumber)}
                        transfers={boutTransfers}
                      />
                    </div>
                  </div>

                  {/* Sidebar (Queue Only) */}
                  {(() => {
                    const upcomingBouts: { id: string; type: 'onDeck' | 'inTheHole' | 'normal'; data: MatchData }[] = [];
                    
                    if (selectedRingObj) {
                      if (selectedRingObj.onDeck && (!selectedRingObj.onDeck.eventId || selectedRingObj.onDeck.eventId === currentEventId)) {
                        upcomingBouts.push({
                          id: `ondeck-${selectedRingObj.onDeck.bout}`,
                          type: 'onDeck',
                          data: selectedRingObj.onDeck
                        });
                      }
                      if (selectedRingObj.inTheHole && (!selectedRingObj.inTheHole.eventId || selectedRingObj.inTheHole.eventId === currentEventId)) {
                        upcomingBouts.push({
                          id: `inhole-${selectedRingObj.inTheHole.bout}`,
                          type: 'inTheHole',
                          data: selectedRingObj.inTheHole
                        });
                      }
                    }
                    
                    const normalQueue = getFilteredQueue(activeDashboardSelectedRing);
                    normalQueue.forEach(item => {
                      upcomingBouts.push({
                        id: item.id,
                        type: 'normal',
                        data: item.data
                      });
                    });

                    return (
                      <div className="space-y-6">
                        {/* Bout Queue */}
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                              <Calendar size={20} className="text-red-600" />
                              Upcoming Bouts (Ring {getRingName(activeDashboardSelectedRing)})
                            </h3>
                            <span className="bg-red-100 text-red-600 text-xs font-bold px-2 py-1 rounded-full">
                              {upcomingBouts.length}
                            </span>
                          </div>
                          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden flex flex-col max-h-[400px]">
                            <div className="p-4 overflow-y-auto space-y-3 font-sans">
                              {upcomingBouts.length === 0 ? (
                                <p className="text-sm text-slate-500 text-center py-8">No upcoming bouts for Ring {getRingName(activeDashboardSelectedRing)}.</p>
                              ) : (
                                upcomingBouts.map((item, idx) => {
                                  return (
                                    <div key={`${item.id}-${idx}`} className={cn(
                                      "border rounded-2xl p-4 flex items-center justify-between shadow-sm gap-3",
                                      item.type === 'onDeck' ? "bg-blue-50/70 border-blue-100" :
                                      item.type === 'inTheHole' ? "bg-amber-50/70 border-amber-100" :
                                      "bg-slate-50 border-slate-100"
                                    )}>
                                      <button 
                                        onClick={() => {
                                          if (item.type === 'onDeck') {
                                            removeBoutFromRingSlot(selectedRingObj.ringNumber, 'onDeck');
                                          } else if (item.type === 'inTheHole') {
                                            removeBoutFromRingSlot(selectedRingObj.ringNumber, 'inTheHole');
                                          } else {
                                            deleteBoutFromQueue(item.id);
                                          }
                                        }}
                                        className="p-1.5 text-slate-300 hover:text-red-500 transition-all shrink-0 cursor-pointer"
                                        title="Remove from Queue"
                                      >
                                        <X size={14} />
                                      </button>
                                      
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                                          <span className="text-[11px] font-bold text-slate-600 bg-slate-200 px-2 py-1 rounded-md">Ring {getRingName(item.data.ring)}</span>
                                          <span className="text-[11px] font-bold text-red-600 bg-red-100 px-2 py-1 rounded-md">Bout {formatBoutNumber(item.data.ring, item.data.bout, boutNumberingMode)}</span>
                                          
                                          {item.type === 'onDeck' && (
                                            <span className="text-[10px] font-black text-blue-600 bg-blue-100 border border-blue-200 px-2 py-0.5 rounded-full uppercase tracking-wider">
                                              On Deck
                                            </span>
                                          )}
                                          {item.type === 'inTheHole' && (
                                            <span className="text-[10px] font-black text-amber-600 bg-amber-100 border border-amber-200 px-2 py-0.5 rounded-full uppercase tracking-wider">
                                              In Hole
                                            </span>
                                          )}

                                          <div className="flex items-center gap-1">
                                            <span className="text-[10px] font-bold text-slate-400">Move:</span>
                                            <select
                                              value={item.data.ring || ''}
                                              onChange={(e) => {
                                                const targetRing = parseInt(e.target.value);
                                                if (targetRing) {
                                                  if (item.type === 'onDeck') {
                                                    transferBoutFromRingSlot(selectedRingObj.ringNumber, 'onDeck', targetRing);
                                                  } else if (item.type === 'inTheHole') {
                                                    transferBoutFromRingSlot(selectedRingObj.ringNumber, 'inTheHole', targetRing);
                                                  } else {
                                                    setBoutQueue(prev => prev.map(q => q.id === item.id ? { ...q, data: { ...q.data, ring: targetRing, originalRing: q.data.originalRing || q.data.ring } } : q));
                                                    addToSyncLog("Transfer Bout Ring", "success", `Transferred Bout ${item.data.bout} from Ring ${item.data.ring} to Ring ${targetRing}`);
                                                    if (!isFirestoreQuotaExceeded) {
                                                      addDoc(collection(db, 'bout_transfers'), {
                                                        fromRing: (item.data.originalRing || item.data.ring).toString(),
                                                        toRing: targetRing.toString(),
                                                        boutNumber: item.data.bout.toString().toUpperCase(),
                                                        timestamp: serverTimestamp(),
                                                        pinnedUntil: new Date(new Date().getTime() + 30 * 60 * 1000).toISOString(),
                                                        isPinned: true,
                                                        author: user?.username || 'Admin'
                                                      }).catch(err => console.error("Auto transfer broadcast error:", err));
                                                    }
                                                  }
                                                }
                                              }}
                                              className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-1 py-0.5 outline-none cursor-pointer hover:bg-indigo-100 transition-colors"
                                            >
                                              {currentRings.map(r => (
                                                <option key={r.ringNumber} value={r.ringNumber}>
                                                  Ring {getRingName(r.ringNumber)}
                                                </option>
                                              ))}
                                            </select>
                                          </div>
                                        </div>
                                        <p className="text-sm font-bold text-slate-800">{cleanPlaceholder(item.data.blue_name)} vs {cleanPlaceholder(item.data.red_name)}</p>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase mt-0.5">{cleanPlaceholder(item.data.category)}</p>
                                      </div>
                                      
                                      <div className="flex flex-col items-end gap-2 shrink-0">
                                        {item.type === 'normal' ? (
                                          <button 
                                            onClick={() => pullBout(item.id)}
                                            className="p-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
                                            title="Pull to Active Ring"
                                          >
                                            <ChevronLeft size={18} />
                                          </button>
                                        ) : (
                                          <button 
                                            onClick={() => pullRingSlotToActive(selectedRingObj.ringNumber, item.type as 'onDeck' | 'inTheHole')}
                                            className="p-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
                                            title="Pull to Active Ring"
                                          >
                                            <ChevronLeft size={18} />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
              </div>
            </>
          );
        })()}

          {activeTab === 'standby' && (
            <StandbyView 
              rings={currentRings} 
              boutQueue={currentBoutQueue} 
              namingMode={ringNamingMode} 
              activeAnnouncement={activeAnnouncement}
              onAnnouncementClose={handleAnnouncementClose}
              currentEventId={currentEventId}
              boutNumberingMode={boutNumberingMode}
              showOnlyActiveRings={showOnlyActiveRings}
              showEmptyBoutAsInactive={showEmptyBoutAsInactive}
              isAdmin={user?.role === 'admin' || user?.role === 'ta'}
              isAdminOnly={user?.role === 'admin'}
              onUpdateInspection={handleUpdateMatchInspection}
              slideInterval={slideInterval}
              boutTransfers={boutTransfers}
              onDeleteTransfer={handleCancelTransferPin}
            />
          )}

          {activeTab === 'site_view' && (
            <SiteView 
              rings={currentRings} 
              boutQueue={currentBoutQueue} 
              namingMode={ringNamingMode} 
              activeAnnouncement={activeAnnouncement}
              onAnnouncementClose={handleAnnouncementClose}
              currentEventId={currentEventId}
              boutNumberingMode={boutNumberingMode}
              showOnlyActiveRings={showOnlyActiveRings}
              showEmptyBoutAsInactive={showEmptyBoutAsInactive}
              isAdmin={user?.role === 'admin' || user?.role === 'ta'}
              isAdminOnly={user?.role === 'admin'}
              onUpdateInspection={handleUpdateMatchInspection}
              slideInterval={slideInterval}
              boutTransfers={boutTransfers}
              onDeleteTransfer={handleCancelTransferPin}
            />
          )}

          {activeTab === 'points' && (
            <PointsView 
              rings={currentRings} 
              boutQueue={currentBoutQueue} 
              namingMode={ringNamingMode} 
              activeAnnouncement={activeAnnouncement}
              onAnnouncementClose={handleAnnouncementClose}
              currentEventId={currentEventId}
              boutNumberingMode={boutNumberingMode}
              showOnlyActiveRings={showOnlyActiveRings}
              showEmptyBoutAsInactive={showEmptyBoutAsInactive}
              isAdmin={user?.role === 'admin' || user?.role === 'ta'}
              isAdminOnly={user?.role === 'admin'}
              slideInterval={slideInterval}
              boutTransfers={boutTransfers}
              onDeleteTransfer={handleCancelTransferPin}
            />
          )}

          {activeTab === 'general' && (
            <OnsiteView 
              rings={currentRings} 
              boutQueue={currentBoutQueue} 
              namingMode={ringNamingMode} 
              activeAnnouncement={activeAnnouncement}
              onAnnouncementClose={handleAnnouncementClose}
              currentEventId={currentEventId}
              boutNumberingMode={boutNumberingMode}
              showOnlyActiveRings={showOnlyActiveRings}
              showEmptyBoutAsInactive={showEmptyBoutAsInactive}
              isAdmin={user?.role === 'admin' || user?.role === 'ta'}
              isAdminOnly={user?.role === 'admin'}
              slideInterval={slideInterval}
              boutTransfers={boutTransfers}
              onDeleteTransfer={handleCancelTransferPin}
            />
          )}

          {activeTab === 'mats' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold flex items-center gap-2">
                  <LayoutDashboard size={20} className="text-red-600" />
                  {user?.role === 'admin' ? "Live Ring Control Center" : `Ring ${getRingName(Number(user?.assignedRing) || 1)} Controller`}
                  {isSyncing && (
                    <span className="ml-4 flex items-center gap-2 text-green-600 text-[10px] font-black animate-pulse">
                      <div className="w-1.5 h-1.5 bg-green-600 rounded-full" />
                      SYNCING TO SYSTEM
                    </span>
                  )}
                  {!googleSheetUrl && (
                    <span className="ml-4 text-red-500 text-[10px] font-black animate-pulse">
                      SYNC DISABLED (NO URL)
                    </span>
                  )}
                </h3>
                {user?.role === 'admin' && (
                  <button 
                    onClick={() => setShowAddRingModal(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-200"
                  >
                    <Plus size={18} />
                    Add New Ring
                  </button>
                )}
              </div>
              <div className={user?.role === 'admin' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"}>
                {user?.role === 'admin' ? (
                  rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount).map((ring) => (
                    <RingCard 
                      key={ring.ringNumber} 
                      ring={ring} 
                      namingMode={ringNamingMode}
                      categories={categories}
                      clubs={clubs}
                      queueCount={getFilteredQueue(ring.ringNumber).length}
                      onUpdate={(data) => handleBoutUpdate(ring.ringNumber, data)}
                      onPointsUpdate={(points) => handlePointsUpdateApp(ring.ringNumber, ring.currentBout?.bout || '', points)}
                      onUpdateTotalBouts={(total) => handleUpdateTotalBouts(ring.ringNumber, total)}
                      onStart={() => startRing(ring.ringNumber)}
                      onDelete={() => deleteRing(ring.ringNumber)}
                      onWinnerSelect={(winner) => handleWinnerSelect(ring.ringNumber, ring.currentBout?.bout || 0, winner)}
                      currentEventId={currentEventId}
                      onForceSync={handleForceSync}
                      isAutoPull={autoPullRings[ring.ringNumber] || false}
                      onToggleAutoPull={() => setAutoPullRings(prev => ({ ...prev, [ring.ringNumber]: !prev[ring.ringNumber] }))}
                      user={user}
                      boutNumberingMode={boutNumberingMode}
                      layout={ringControlLayout}
                      showInspectionPopupSetting={showInspectionPopupSetting}
                      onReturnToQueue={() => returnActiveBoutToQueue(ring.ringNumber)}
                      onResumeSuspended={(boutNum) => resumeSuspendedBout(ring.ringNumber, boutNum)}
                      onRemoveSuspended={(boutNum) => removeSuspendedBout(ring.ringNumber, boutNum)}
                      onSuspendCurrentBout={() => suspendActiveBout(ring.ringNumber)}
                      transfers={boutTransfers}
                    />
                  ))
                ) : (
                  <>
                    <div className="lg:col-span-2">
                      {rings.filter(r => r.ringNumber === Number(user?.assignedRing) && !r.isDeleted && r.ringNumber <= visibleRingsCount).map((ring) => (
                        <RingCard 
                          key={ring.ringNumber} 
                          ring={ring} 
                          namingMode={ringNamingMode}
                          categories={categories}
                          clubs={clubs}
                          queueCount={getFilteredQueue(ring.ringNumber).length}
                          onUpdate={(data) => handleBoutUpdate(ring.ringNumber, data)}
                          onPointsUpdate={(points) => handlePointsUpdateApp(ring.ringNumber, ring.currentBout?.bout || '', points)}
                          onUpdateTotalBouts={(total) => handleUpdateTotalBouts(ring.ringNumber, total)}
                          onStart={() => startRing(ring.ringNumber)}
                          onWinnerSelect={(winner) => handleWinnerSelect(ring.ringNumber, ring.currentBout?.bout || 0, winner)}
                          currentEventId={currentEventId}
                          onForceSync={handleForceSync}
                          isAutoPull={autoPullRings[ring.ringNumber] || false}
                          onToggleAutoPull={() => setAutoPullRings(prev => ({ ...prev, [ring.ringNumber]: !prev[ring.ringNumber] }))}
                          user={user}
                          boutNumberingMode={boutNumberingMode}
                          layout={ringControlLayout}
                          showInspectionPopupSetting={showInspectionPopupSetting}
                          onReturnToQueue={() => returnActiveBoutToQueue(ring.ringNumber)}
                          onResumeSuspended={(boutNum) => resumeSuspendedBout(ring.ringNumber, boutNum)}
                          onRemoveSuspended={(boutNum) => removeSuspendedBout(ring.ringNumber, boutNum)}
                          onSuspendCurrentBout={() => suspendActiveBout(ring.ringNumber)}
                          transfers={boutTransfers}
                        />
                      ))}
                    </div>
                    <div className="lg:col-span-2 space-y-6">
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                            <Calendar size={20} className="text-red-600" />
                            Upcoming Bouts
                          </h3>
                          <span className="bg-red-100 text-red-600 text-xs font-bold px-2 py-1 rounded-full">
                            {getFilteredQueue().length}
                          </span>
                        </div>
                        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden flex flex-col max-h-[600px]">
                          <div className="p-4 overflow-y-auto space-y-3">
                            {getFilteredQueue().length === 0 ? (
                              <p className="text-sm text-slate-500 text-center py-8">No upcoming bouts.</p>
                            ) : (
                              getFilteredQueue().map((item, idx) => (
                                <div key={`${item.id}-${idx}`} className="bg-slate-50 border border-slate-100 rounded-2xl p-4 flex items-center justify-between shadow-sm">
                                  <div className="flex items-center gap-3 w-full">
                                    <button 
                                      onClick={() => deleteBoutFromQueue(item.id)}
                                      className="p-1.5 text-slate-300 hover:text-red-500 transition-all shrink-0"
                                      title="Remove from Queue"
                                    >
                                      <X size={14} />
                                    </button>
                                    <div className="flex-1">
                                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                                        <span className="text-[11px] font-bold text-slate-600 bg-slate-200 px-2 py-1 rounded-md">Ring {item.data.ring}</span>
                                        <span className="text-[11px] font-bold text-red-600 bg-red-100 px-2 py-1 rounded-md">Bout {formatBoutNumber(item.data.ring, item.data.bout, boutNumberingMode)}</span>
                                        <div className="flex items-center gap-1">
                                          <span className="text-[10px] font-bold text-slate-400">Move:</span>
                                          <select
                                            value={item.data.ring || ''}
                                            onChange={(e) => {
                                              const targetRing = parseInt(e.target.value);
                                              if (targetRing) {
                                                setBoutQueue(prev => prev.map(q => q.id === item.id ? { ...q, data: { ...q.data, ring: targetRing, originalRing: q.data.originalRing || q.data.ring } } : q));
                                                addToSyncLog("Transfer Bout Ring", "success", `Transferred Bout ${item.data.bout} from Ring ${item.data.ring} to Ring ${targetRing}`);
                                                if (!isFirestoreQuotaExceeded) {
                                                  addDoc(collection(db, 'bout_transfers'), {
                                                    fromRing: (item.data.originalRing || item.data.ring).toString(),
                                                    toRing: targetRing.toString(),
                                                    boutNumber: item.data.bout.toString().toUpperCase(),
                                                    timestamp: serverTimestamp(),
                                                    pinnedUntil: new Date(new Date().getTime() + 30 * 60 * 1000).toISOString(),
                                                    isPinned: true,
                                                    author: user?.username || 'Admin'
                                                  }).catch(err => console.error("Auto transfer broadcast error:", err));
                                                }
                                              }
                                            }}
                                            className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-1 py-0.5 outline-none cursor-pointer hover:bg-indigo-100 transition-colors"
                                          >
                                            {currentRings.map(r => (
                                              <option key={r.ringNumber} value={r.ringNumber}>
                                                Ring {getRingName(r.ringNumber)}
                                              </option>
                                            ))}
                                          </select>
                                        </div>
                                      </div>
                                      <p className="text-sm font-bold text-slate-800">{cleanPlaceholder(item.data.blue_name)} vs {cleanPlaceholder(item.data.red_name)}</p>
                                      <p className="text-[10px] font-bold text-slate-400 uppercase mt-0.5">{cleanPlaceholder(item.data.category)}</p>
                                    </div>
                                  </div>
                                  <div className="flex flex-col items-end gap-2 shrink-0">
                                    <button 
                                      onClick={() => pullBout(item.id)}
                                      className="p-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-colors"
                                      title="Pull to Active Ring"
                                    >
                                      <ChevronLeft size={18} />
                                    </button>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === 'ta-sheet' && (
            <div className="max-w-5xl mx-auto">
              <TASheet 
                key="ta-sheet-view"
                boutQueue={boutQueue} 
                rings={rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount)} 
                currentEventName={getCurrentEventName()} 
                currentEventDate={getCurrentEventDate()}
                currentEventId={currentEventId}
                events={events}
                matchHistory={matchHistory}
                onUpdateInspection={handleUpdateMatchInspection}
                viewMode="print"
                boutNumberingMode={boutNumberingMode}
                isAutoUpdateNames={isAutoUpdateNames}
                onToggleAutoUpdateNames={setIsAutoUpdateNames}
                onCreateNewBout={() => setShowNewBoutModal(true)}
                categories={categories}
                clubs={clubs}
                onCreateManualInspectionBout={handleCreateManualInspectionBout}
              />
            </div>
          )}

          {activeTab === 'player-signature' && (
            <div className="max-w-5xl mx-auto">
              <TASheet 
                key="signature-view"
                boutQueue={boutQueue} 
                rings={rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount)} 
                currentEventName={getCurrentEventName()} 
                currentEventDate={getCurrentEventDate()}
                currentEventId={currentEventId}
                events={events}
                matchHistory={matchHistory}
                onUpdateInspection={handleUpdateMatchInspection}
                viewMode="signature"
                boutNumberingMode={boutNumberingMode}
                isAutoUpdateNames={isAutoUpdateNames}
                onToggleAutoUpdateNames={setIsAutoUpdateNames}
                onCreateNewBout={() => setShowNewBoutModal(true)}
                categories={categories}
                clubs={clubs}
                onCreateManualInspectionBout={handleCreateManualInspectionBout}
              />
            </div>
          )}

          {activeTab === 'mapping' && user?.role === 'admin' && (
            <AdminMapping 
              currentEventId={currentEventId} 
              currentEventName={getCurrentEventName()}
              categories={categories} 
              events={events}
              onSyncMatches={handleAdminImportBouts}
              isSyncingMatches={isImportingBouts}
              boutNumberingMode={boutNumberingMode}
              matchHistory={matchHistory}
            />
          )}

          {activeTab === 'search-winner' && (
            <SearchWinner 
              matchHistory={matchHistory}
              currentEventId={currentEventId}
              onRestoreMatch={handleRestoreMatch}
            />
          )}

          {activeTab === 'report' && (
            <EventReport
              currentEventId={currentEventId}
              events={events}
            />
          )}

          {activeTab === 'ai-setup' && user?.role === 'admin' && (
            <AIBracketSetup 
              currentEventId={currentEventId}
              events={events}
              onSelectEvent={(id) => {
                setCurrentEventId(id);
                localStorage.setItem('tkd_current_event_v3', id);
                const event = events.find(ev => ev.id === id);
                if (event && event.sheetUrl) {
                  setGoogleSheetUrl(event.sheetUrl);
                  localStorage.setItem('tkd_sheet_url', event.sheetUrl);
                }
              }}
              onSuccess={() => setActiveTab('mapping')}
              rings={rings}
              setRings={setRings}
              setBoutQueue={setBoutQueue}
              boutNumberingMode={boutNumberingMode}
              setBackupData={setBackupData}
              backupToLoad={backupToLoad}
              clearBackupToLoad={() => setBackupToLoad(null)}
            />
          )}

          {activeTab === 'bout-chart' && user?.role === 'admin' && (
            <div className="max-w-7xl mx-auto">
               <BoutChart 
                  mappings={mappings}
                  boutQueue={boutQueue}
                  matchHistory={matchHistory}
                  boutNumberingMode={boutNumberingMode}
                  onUpdateBoutNumber={handleUpdateBoutNumberFromBracket}
                  onUpdateBoutName={handleUpdateBoutNameFromBracket}
               />
            </div>
          )}

          {activeTab === 'inspection-logs' && (user?.role === 'admin' || user?.role === 'ta') && (
            <div className="max-w-5xl mx-auto">
              <InspectionLogs boutQueue={boutQueue} rings={rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount)} matchHistory={matchHistory} boutNumberingMode={boutNumberingMode} currentEventId={currentEventId} />
            </div>
          )}

          {activeTab === 'settings' && user?.role === 'admin' && (
            <div className="max-w-4xl mx-auto space-y-8">
              <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <Settings size={24} className="text-slate-400" />
                  System Configuration
                </h3>
                
                <div className="space-y-4">
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-slate-700">Cloud Real-Time Sync (Firebase)</h4>
                      <p className="text-[10px] text-slate-500 mt-1">If enabled, scoreboards will sync globally over the internet. Disable this if you hit your daily quota or want to run 100% offline (LocalStorage only).</p>
                    </div>
                    {isFirestoreQuotaExceeded ? (
                      <button 
                        onClick={manuallyEnableFirebase}
                        className="px-4 py-2 bg-green-100 text-green-700 rounded-lg text-xs font-bold whitespace-nowrap hover:bg-green-200 transition-colors"
                      >
                        Enable Cloud Sync
                      </button>
                    ) : (
                      <button 
                        onClick={manuallyDisableFirebase}
                        className="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-xs font-bold whitespace-nowrap hover:bg-red-200 transition-colors"
                      >
                        Disable Sync (Go Offline)
                      </button>
                    )}
                  </div>
                  
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                    <label className="block text-sm font-bold text-slate-700 mb-2">Google Sheets Web App URL</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={localSheetUrl}
                        onChange={(e) => setLocalSheetUrl(e.target.value)}
                        placeholder="https://script.google.com/macros/s/.../exec"
                        className="flex-1 px-4 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none transition-all"
                      />
                      <button 
                        onClick={() => {
                          setGoogleSheetUrl(localSheetUrl);
                          localStorage.setItem('tkd_sheet_url', localSheetUrl);
                          // Also persist URL prefix to current event
                          if (currentEventId && events.length > 0) {
                            const updated = events.map(e => e.id === currentEventId ? { ...e, sheetUrl: localSheetUrl } : e);
                            setEvents(updated);
                            localStorage.setItem('tkd_events_v3', JSON.stringify(updated));
                          }
                          setIsSheetSaved(true);
                          setTimeout(() => setIsSheetSaved(false), 2000);
                        }}
                        className={cn(
                          "px-4 py-2 rounded-lg font-bold text-sm transition-all",
                          isSheetSaved ? "bg-green-600 text-white" : "bg-slate-900 text-white"
                        )}
                      >
                        {isSheetSaved ? "Saved!" : "Save URL"}
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2">
                      Deploy a Google Apps Script as a Web App to receive match data.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Ring Naming Mode</p>
                        <p className="text-[10px] text-slate-500">Numbers vs Alphabets</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setRingNamingMode('number')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            ringNamingMode === 'number' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          1, 2, 3
                        </button>
                        <button 
                          onClick={() => setRingNamingMode('alphabet')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            ringNamingMode === 'alphabet' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          A, B, C
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Bout Numbering Method</p>
                        <p className="text-[10px] text-slate-500">1001 vs A01</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setBoutNumberingMode('numeric')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            boutNumberingMode === 'numeric' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          1001
                        </button>
                        <button 
                          onClick={() => setBoutNumberingMode('alphanumeric')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            boutNumberingMode === 'alphanumeric' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          A01
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Public View Total Bouts</p>
                        <p className="text-[10px] text-slate-500">Show total bouts (e.g., 1/10)</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setShowTotalBoutsPublic(true)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            showTotalBoutsPublic ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Show
                        </button>
                        <button 
                          onClick={() => setShowTotalBoutsPublic(false)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            !showTotalBoutsPublic ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Display Filters</p>
                        <p className="text-[10px] text-slate-500">Show only rings with active bouts</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setShowOnlyActiveRings(false)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            !showOnlyActiveRings ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          All Rings
                        </button>
                        <button 
                          onClick={() => setShowOnlyActiveRings(true)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            showOnlyActiveRings ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Active Only
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Public View Layout</p>
                        <p className="text-[10px] text-slate-500">Default vs Live Points</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setPublicViewLayout('standard')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            publicViewLayout === 'standard' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Standard
                        </button>
                        <button 
                          onClick={() => setPublicViewLayout('point')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            publicViewLayout === 'point' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Points
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-slate-700 font-sans">Public View Event / Day</p>
                        <p className="text-[10px] text-slate-500 font-sans">Choose which tournament day or event is displayed live on public screens</p>
                      </div>
                      <select
                        value={publicEventId}
                        onChange={(e) => setPublicEventId(e.target.value)}
                        className="px-4 py-2 bg-white rounded-xl text-[10px] md:text-xs font-black text-slate-600 border border-slate-200 uppercase tracking-widest focus:ring-2 focus:ring-red-500 outline-none w-full sm:w-auto min-w-[200px] cursor-pointer"
                      >
                        <option value="active">Active Operator Event</option>
                        {events.map((e, i) => (
                          <option key={`${e.id}-${i}`} value={e.id}>{e.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-slate-700 font-sans">Number of Visible Rings</p>
                        <p className="text-[10px] text-slate-500 font-sans">Choose how many rings are visible across all views (1 to 12)</p>
                      </div>
                      <select
                        value={visibleRingsCount}
                        onChange={(e) => setVisibleRingsCount(Number(e.target.value))}
                        className="px-4 py-2 bg-white rounded-xl text-[10px] md:text-xs font-black text-slate-600 border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none w-full sm:w-auto min-w-[200px] cursor-pointer"
                      >
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((num) => (
                          <option key={num} value={num}>
                            {num} {num === 1 ? 'Ring' : 'Rings'} (1 - {ringNamingMode === 'alphabet' ? String.fromCharCode(64 + num) : num})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-slate-700 font-sans">Slide Change Interval</p>
                        <p className="text-[10px] text-slate-500 font-sans">How many seconds before auto-sliding in Standby/Points/Onsite views</p>
                      </div>
                      <select
                        value={slideInterval}
                        onChange={(e) => setSlideInterval(Number(e.target.value))}
                        className="px-4 py-2 bg-white rounded-xl text-[10px] md:text-xs font-black text-slate-600 border border-slate-200 focus:ring-2 focus:ring-red-500 outline-none w-full sm:w-auto min-w-[200px] cursor-pointer"
                      >
                        {[5, 10, 15, 20, 30, 45, 60].map((num) => (
                          <option key={num} value={num}>
                            {num} seconds
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Empty Ring View</p>
                        <p className="text-[10px] text-slate-500">How to display rings without active bouts</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setShowEmptyBoutAsInactive(false)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            !showEmptyBoutAsInactive ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Blurred View
                        </button>
                        <button 
                          onClick={() => setShowEmptyBoutAsInactive(true)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            showEmptyBoutAsInactive ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Inactive View
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Ring Control Layout</p>
                        <p className="text-[10px] text-slate-500">Choose the layout of the ring control panel</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setRingControlLayout('winner')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            ringControlLayout === 'winner' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Winner Only
                        </button>
                        <button 
                          onClick={() => setRingControlLayout('point')}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            ringControlLayout === 'point' ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Points Layout
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Public View Standby Queue</p>
                        <p className="text-[10px] text-slate-500">Show next bouts in public dashboard</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setShowPublicStandbyQueue(true)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            showPublicStandbyQueue ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Show
                        </button>
                        <button 
                          onClick={() => setShowPublicStandbyQueue(false)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            !showPublicStandbyQueue ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Hide
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Ring View Inspection Warning</p>
                        <p className="text-[10px] text-slate-500">Show pop-up warning in ring controls if competitor has not passed inspection</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setShowInspectionPopupSetting(true)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            showInspectionPopupSetting ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Enable
                        </button>
                        <button 
                          onClick={() => setShowInspectionPopupSetting(false)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            !showInspectionPopupSetting ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Disable
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Result Submission Confirmation</p>
                        <p className="text-[10px] text-slate-500">Require conformation pop-up when submitting a match winner result</p>
                      </div>
                      <div className="flex bg-slate-200 p-1 rounded-lg">
                        <button 
                          onClick={() => setConfirmResultSubmission(true)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            confirmResultSubmission ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Enable
                        </button>
                        <button 
                          onClick={() => setConfirmResultSubmission(false)}
                          className={cn(
                            "px-3 py-1 text-[10px] font-bold rounded-md transition-all",
                            !confirmResultSubmission ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                          )}
                        >
                          Disable
                        </button>
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">PDPA Privacy Mode</p>
                        <p className="text-[10px] text-slate-500">Global override for minors</p>
                      </div>
                      <div className="w-12 h-6 bg-red-600 rounded-full relative cursor-pointer">
                        <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
                      </div>
                    </div>
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-bold text-slate-700">Multilingual Engine</p>
                        <p className="text-[10px] text-slate-500">English & Bahasa Melayu</p>
                      </div>
                      <CheckCircle2 className="text-green-500" size={20} />
                    </div>
                  </div>
                </div>
              </div>

              <DataUpdater setCategories={setCategories} setClubs={setClubs} />

              <EventManagement 
                events={events}
                onAdd={handleAddEvent}
                onDelete={handleDeleteEvent}
                onUpdate={handleUpdateEvent}
              />

              <UserManagement 
                accounts={accounts} 
                onAdd={handleAddAccount} 
                onDelete={handleDeleteAccount} 
                onEditPassword={handleEditPassword}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <IntegrationCard 
                  title="Billplz" 
                  description="Malaysian Payment Gateway" 
                  icon={<CreditCard className="text-blue-600" />}
                />
                <IntegrationCard 
                  title="WhatsApp API" 
                  description="Coach Notifications" 
                  icon={<Bell className="text-green-600" />}
                />
              </div>
            </div>
          )}
        </div>
      </main>

      {pendingWinnerSelection && (() => {
        const { ringNumber, boutNumber, winner } = pendingWinnerSelection;
        const ring = rings.find(r => r.ringNumber === ringNumber);
        const currentBout = ring?.currentBout;
        
        let winnerName = '';
        let winnerColor = '';
        let winnerClass = '';
        let iconClass = 'bg-red-50 text-red-600';
        let btnColorClass = 'bg-red-600 hover:bg-red-700';
        
        if (winner === 'Blue') {
          winnerName = currentBout?.blue_name || 'Blue Competitor';
          winnerColor = 'Blue Corner';
          winnerClass = 'text-blue-600 bg-blue-50 border-blue-200';
          iconClass = 'bg-blue-50 text-blue-600';
          btnColorClass = 'bg-blue-600 hover:bg-blue-700';
        } else if (winner === 'Red') {
          winnerName = currentBout?.red_name || 'Red Competitor';
          winnerColor = 'Red Corner';
          winnerClass = 'text-red-500 bg-red-50 border-red-200';
          iconClass = 'bg-red-50 text-red-600';
          btnColorClass = 'bg-red-600 hover:bg-red-700';
        } else {
          winnerName = 'Completed / Tie';
          winnerColor = 'Completed';
          winnerClass = 'text-slate-600 bg-slate-50 border-slate-200';
          iconClass = 'bg-slate-50 text-slate-600';
          btnColorClass = 'bg-slate-600 hover:bg-slate-700';
        }

        const ringLabel = ringNamingMode === 'alphabet' ? String.fromCharCode(64 + ringNumber) : `Ring ${ringNumber}`;

        return (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl border border-slate-200 space-y-5 text-slate-800"
            >
              <div className="flex items-start gap-4">
                <div className={`p-3 rounded-xl ${iconClass}`}>
                  <AlertCircle size={24} />
                </div>
                <div className="flex-1 space-y-1">
                  <h3 className="text-lg font-bold text-slate-900">Confirm Winner Result</h3>
                  <p className="text-xs text-slate-500">
                    Are you sure you want to finalize this match and submit the result?
                  </p>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-3 text-sm">
                <div className="flex justify-between items-center text-xs text-slate-500 border-b border-dashed border-slate-200 pb-2">
                  <span className="font-semibold uppercase tracking-wider">{ringLabel}</span>
                  <span className="font-bold">Bout {boutNumber}</span>
                </div>
                
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-slate-400">CATEGORY</p>
                  <p className="font-bold text-slate-800">{currentBout?.category || 'General Class'}</p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <span className="text-[10px] font-bold text-blue-500">BLUE</span>
                    <p className="font-bold truncate text-slate-700">{currentBout?.blue_name || '-'}</p>
                    <span className="text-[10px] text-slate-400">{currentBout?.blue_club || ''}</span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] font-bold text-red-500">RED</span>
                    <p className="font-bold truncate text-slate-700">{currentBout?.red_name || '-'}</p>
                    <span className="text-[10px] text-slate-400">{currentBout?.red_club || ''}</span>
                  </div>
                </div>

                <div className={`mt-2 p-3 rounded-lg border flex flex-col items-center justify-center text-center ${winnerClass}`}>
                  <span className="text-[10px] font-bold tracking-widest uppercase opacity-75">WINNER TO BE SENT</span>
                  <p className="text-base font-black uppercase mt-1">{winnerName}</p>
                  <p className="text-xs font-bold opacity-80">({winnerColor})</p>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setPendingWinnerSelection(null)}
                  className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl font-bold text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    executeWinnerSelect(ringNumber, boutNumber, winner);
                    setPendingWinnerSelection(null);
                  }}
                  className={`flex-1 px-4 py-2.5 text-white rounded-xl font-bold text-sm shadow-sm transition-colors ${btnColorClass}`}
                >
                  Confirm & Submit
                </button>
              </div>
            </motion.div>
          </div>
        );
      })()}

      {showNewBoutModal && (
        <NewBoutModal 
          onClose={() => {
            setShowNewBoutModal(false);
            setNewBoutInitialRing(undefined);
          }}
          onSubmit={(ringNumber, data) => handleNewBoutSubmit(ringNumber, data)}
          categories={categories}
          clubs={clubs}
          rings={currentRings}
          queue={currentBoutQueue}
          user={user}
          initialRing={newBoutInitialRing}
          currentEventId={currentEventId}
          events={events}
          isSyncing={isSyncing}
          boutNumberingMode={boutNumberingMode}
          matchHistory={matchHistory}
        />
      )}

      {finalBoutCheck && (
        <FinalBoutCheckModal 
          ringNumber={finalBoutCheck.ringNumber}
          remainingCount={finalBoutCheck.remainingCount}
          onConfirmFinal={() => {
            setRings(prev => {
              const updated = prev.map(r => r.ringNumber === finalBoutCheck.ringNumber ? { ...r, isFinalBouts: true } : r);
              localStorage.setItem('tkd_rings', JSON.stringify(updated));
              return updated;
            });
            setFinalBoutCheck(null);
          }}
          onAddBout={() => {
            setNewBoutInitialRing(finalBoutCheck.ringNumber);
            setFinalBoutCheck(null);
            setShowNewBoutModal(true);
          }}
        />
      )}

      {showEditResultModal && (
        <EditResultModal
          onClose={() => setShowEditResultModal(false)}
          onSubmit={(ringNumber, boutNumber, winner) => {
            // Find names for winner propagation
            let winName: string = winner;
            let winClub = '';
            let cat = '';
            
            const normalized = normalizeBoutNumber(boutNumber);
            let found: MatchData | null = null;
            const ring = rings.find(r => r.ringNumber === ringNumber);
            if (ring) {
              if (ring.currentBout && isBoutMatch(ring.currentBout.bout, normalized)) found = ring.currentBout;
              else if (ring.onDeck && isBoutMatch(ring.onDeck.bout, normalized)) found = ring.onDeck;
              else if (ring.inTheHole && isBoutMatch(ring.inTheHole.bout, normalized)) found = ring.inTheHole;
            }
            if (!found) {
              const queued = boutQueue.find(q => q.data.ring === ringNumber && isBoutMatch(q.data.bout, normalized));
              if (queued) found = queued.data;
            }

            if (found) {
              if (winner === 'Completed') {
                winName = 'Completed';
                winClub = found.blue_club || '';
              } else {
                winName = winner === 'Blue' ? found.blue_name : found.red_name;
                winClub = winner === 'Blue' ? found.blue_club : found.red_club;
              }
              cat = found.category;
            }

            if (googleSheetUrl) {
              setIsSyncing(true);
              const targetSyncRing = found?.originalRing || ringNumber;
              const winnerClub = winner === 'Blue' ? found?.blue_club : (winner === 'Red' ? found?.red_club : '-');
              updateWinnerInGoogleSheets(
                googleSheetUrl,
                targetSyncRing,
                boutNumber,
                winName,
                getCurrentEventName(),
                winner,
                found?.blue_name,
                found?.red_name,
                found?.points,
                winnerClub,
                found?.blue_club,
                found?.red_club
              ).finally(() => setIsSyncing(false));
            }

            // Update match history
            if (currentEventId) {
              const historyItem: MatchHistoryItem = {
                id: `${currentEventId}_${normalizeBoutNumber(boutNumber)}`,
                bout: normalizeBoutNumber(boutNumber),
                category: cat,
                winner: winName,
                winnerClub: winClub,
                winnerSide: (winner === 'Blue' || winner === 'Red') ? winner : undefined,
                eventId: currentEventId,
                ring: Number(ringNumber)
              };
              
              setMatchHistory(prev => {
                const filtered = prev.filter(h => h.id !== historyItem.id);
                return [...filtered, historyItem];
              });

              // Firestore
              const toSave: any = {
                ...historyItem,
                syncedAt: serverTimestamp()
              };
              if (toSave.winnerSide === undefined) delete toSave.winnerSide;
              if (toSave.winnerClub === undefined) delete toSave.winnerClub;

              if (!isFirestoreQuotaExceeded) {
                setDoc(doc(db, 'matchHistory', historyItem.id), toSave).catch(err => {
                  console.error("Error updating history:", err);
                  if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
                    handleGlobalQuotaTrigger();
                  }
                });
              }

              // Advancement
              checkAndGenerateNextBout(boutNumber, winName, winClub, cat);
            }
          }}
          rings={currentRings}
          queue={currentBoutQueue}
          user={user}
          boutNumberingMode={boutNumberingMode}
          events={events}
          currentEventId={currentEventId}
        />
      )}

      {showEditBoutDetailsModal && (
        <EditBoutDetailsModal
          onClose={() => setShowEditBoutDetailsModal(false)}
          events={events}
          currentEventId={currentEventId}
          onSubmit={(ringNumber, boutNumber, updates) => {
            // Check if bout already exists in rings or queue
            let exists = false;
            rings.forEach(r => {
              if (r.ringNumber === ringNumber) {
                if (r.currentBout && isBoutMatch(r.currentBout.bout, boutNumber)) exists = true;
                if (r.onDeck && isBoutMatch(r.onDeck.bout, boutNumber)) exists = true;
                if (r.inTheHole && isBoutMatch(r.inTheHole.bout, boutNumber)) exists = true;
              }
            });
            if (!exists) {
              const inQ = boutQueue.some(q => q.data.ring === ringNumber && isBoutMatch(q.data.bout, boutNumber));
              if (inQ) exists = true;
            }

            if (!exists) {
              // Creating a brand new bout!
              const targetNormalizedBout = normalizeBoutWithRing(boutNumber, ringNumber);
              const newMatchData: MatchData = {
                ring: ringNumber,
                bout: targetNormalizedBout,
                blue_name: updates.blue_name?.toUpperCase() || '',
                blue_club: updates.blue_club?.toUpperCase() || '',
                red_name: updates.red_name?.toUpperCase() || '',
                red_club: updates.red_club?.toUpperCase() || '',
                category: updates.category?.toUpperCase() || '',
                eventId: currentEventId || null,
                isManuallyEdited: true,
                privacy_mode: false,
                allowCompleted: true
              };
              
              if (newMatchData.category && !categories.includes(newMatchData.category)) {
                setCategories(prev => [...prev, newMatchData.category]);
              }
              if (newMatchData.blue_club && !clubs.includes(newMatchData.blue_club)) {
                setClubs(prev => [...prev, newMatchData.blue_club]);
              }
              if (newMatchData.red_club && !clubs.includes(newMatchData.red_club)) {
                setClubs(prev => [...prev, newMatchData.red_club]);
              }
              
              const queueItem = { 
                id: Math.random().toString(36).substr(2, 9), 
                data: newMatchData 
              };
              
              setBoutQueue(prev => [...prev, queueItem]);
              console.log("Adding non-existent bout to queue from EditBoutDetailsModal:", queueItem);

              // Sync to Google Sheets as a new bout
              if (googleSheetUrl) {
                setIsSyncing(true);
                syncToGoogleSheets(googleSheetUrl, newMatchData, getCurrentEventName())
                  .finally(() => setIsSyncing(false));
              }
            } else {
              // Update in rings (all slots: current, onDeck, inTheHole)
              setRings(prev => prev.map(r => {
                if (r.ringNumber === ringNumber) {
                  let changed = false;
                  const newRing = { ...r };

                  if (r.currentBout && isBoutMatch(r.currentBout.bout, boutNumber)) {
                    newRing.currentBout = { ...r.currentBout, ...updates };
                    changed = true;
                  }
                  if (r.onDeck && isBoutMatch(r.onDeck.bout, boutNumber)) {
                    newRing.onDeck = { ...r.onDeck, ...updates };
                    changed = true;
                  }
                  if (r.inTheHole && isBoutMatch(r.inTheHole.bout, boutNumber)) {
                    newRing.inTheHole = { ...r.inTheHole, ...updates };
                    changed = true;
                  }

                  return changed ? newRing : r;
                }
                return r;
              }));

              // Update in queue
              setBoutQueue(prev => prev.map(q => {
                if (q.data.ring === ringNumber && isBoutMatch(q.data.bout, boutNumber)) {
                  return {
                    ...q,
                    data: { ...q.data, ...updates }
                  };
                }
                return q;
              }));

              // Find match to determine originalRing
              let foundMatch: MatchData | null = null;
              const targetRingObj = rings.find(r => r.ringNumber === ringNumber);
              if (targetRingObj) {
                if (targetRingObj.currentBout && isBoutMatch(targetRingObj.currentBout.bout, boutNumber)) foundMatch = targetRingObj.currentBout;
                else if (targetRingObj.onDeck && isBoutMatch(targetRingObj.onDeck.bout, boutNumber)) foundMatch = targetRingObj.onDeck;
                else if (targetRingObj.inTheHole && isBoutMatch(targetRingObj.inTheHole.bout, boutNumber)) foundMatch = targetRingObj.inTheHole;
              }
              if (!foundMatch) {
                const qMatch = boutQueue.find(q => q.data.ring === ringNumber && isBoutMatch(q.data.bout, boutNumber));
                if (qMatch) foundMatch = qMatch.data;
              }
              const targetSyncRing = foundMatch?.originalRing || ringNumber;

              // Sync to Google Sheets
              if (googleSheetUrl) {
                setIsSyncing(true);
                updateBoutDetailsInGoogleSheets(
                  googleSheetUrl,
                  targetSyncRing,
                  boutNumber,
                  updates.blue_name || '',
                  updates.blue_club || '',
                  updates.red_name || '',
                  updates.red_club || '',
                  getCurrentEventName()
                ).finally(() => setIsSyncing(false));
              }
            }

            // Update match history if it already exists for this bout
            if (currentEventId) {
              const histId = `${currentEventId}_${normalizeBoutNumber(boutNumber)}`;
              const existingHist = matchHistory.find(h => h.id === histId);
              if (existingHist) {
                // Find old names to determine who was the winner
                let oldMatch: MatchData | null = null;
                const ring = rings.find(r => r.ringNumber === ringNumber);
                if (ring) {
                  if (ring.currentBout && isBoutMatch(ring.currentBout.bout, boutNumber)) oldMatch = ring.currentBout;
                  else if (ring.onDeck && isBoutMatch(ring.onDeck.bout, boutNumber)) oldMatch = ring.onDeck;
                  else if (ring.inTheHole && isBoutMatch(ring.inTheHole.bout, boutNumber)) oldMatch = ring.inTheHole;
                }
                if (!oldMatch) {
                  const q = boutQueue.find(qi => qi.data.ring === ringNumber && isBoutMatch(qi.data.bout, boutNumber));
                  if (q) oldMatch = q.data;
                }

                if (oldMatch) {
                  const isBlueWinner = existingHist.winner === oldMatch.blue_name;
                  const isRedWinner = existingHist.winner === oldMatch.red_name;

                  if (isBlueWinner || isRedWinner) {
                    const side: 'Blue' | 'Red' = existingHist.winnerSide || (isBlueWinner ? 'Blue' : 'Red');
                    const newWinName = side === 'Blue' ? (updates.blue_name || oldMatch.blue_name) : (updates.red_name || oldMatch.red_name);
                    const newWinClub = side === 'Blue' ? (updates.blue_club || oldMatch.blue_club) : (updates.red_club || oldMatch.red_club);

                    const updatedHistItem: MatchHistoryItem = { 
                      ...existingHist, 
                      winner: newWinName, 
                      winnerClub: newWinClub,
                      winnerSide: side,
                      ring: ringNumber
                    };
                    setMatchHistory(prev => prev.map(h => h.id === histId ? updatedHistItem : h));

                    // Store to Firestore
                    const toSave: any = {
                      ...updatedHistItem,
                      syncedAt: serverTimestamp()
                    };
                    if (toSave.winnerSide === undefined) delete toSave.winnerSide;
                    if (toSave.winnerClub === undefined) delete toSave.winnerClub;

                    if (!isFirestoreQuotaExceeded) {
                      setDoc(doc(db, 'matchHistory', histId), toSave).catch(err => {
                        console.error("Error updating history on name change:", err);
                        if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
                          handleGlobalQuotaTrigger();
                        }
                      });
                    }

                    // RE-PROPAGATE to brackets!
                    checkAndGenerateNextBout(boutNumber, newWinName, newWinClub, oldMatch.category);
                  }
                }
              }
            }
          }}
          rings={currentRings}
          queue={currentBoutQueue}
          user={user}
          boutNumberingMode={boutNumberingMode}
        />
      )}

      {!['standby', 'general', 'site_view'].includes(activeTab) && (
        <AnnouncementPopup announcement={activeAnnouncement} onClose={handleAnnouncementClose} />
      )}

      {/* Announcement Input Modal */}
      <AnimatePresence>
        {showAnnouncementInput && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-[110]">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg overflow-hidden"
            >
              <div className="p-8 bg-slate-900 text-white flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-900/20">
                    <Bell size={24} className="text-white" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black uppercase tracking-tight italic">Broadcast Message</h2>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Send to all users instantly</p>
                  </div>
                </div>
                <button onClick={() => setShowAnnouncementInput(false)} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
                  <X size={24} />
                </button>
              </div>
              
              {/* Tab selector */}
              <div className="flex border-b border-slate-100 bg-slate-50">
                <button
                  onClick={() => setBroadcastModalType('standard')}
                  className={cn(
                    "flex-1 py-4 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all cursor-pointer",
                    broadcastModalType === 'standard'
                      ? "border-red-600 text-red-600 bg-white"
                      : "border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                  )}
                >
                  Standard
                </button>
                <button
                  onClick={() => setBroadcastModalType('transfer')}
                  className={cn(
                    "flex-1 py-4 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all cursor-pointer",
                    broadcastModalType === 'transfer'
                      ? "border-red-600 text-red-600 bg-white"
                      : "border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                  )}
                >
                  Bout Transfer
                </button>
              </div>

              {broadcastModalType === 'standard' ? (
                <div className="p-8 space-y-6">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Target Audience</label>
                    <select
                      value={announcementTarget}
                      onChange={(e) => setAnnouncementTarget(e.target.value as 'all' | 'users')}
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-3xl text-sm font-bold text-slate-800 focus:border-red-600 focus:ring-0 outline-none transition-all"
                    >
                      <option value="all">Broadcast to All (Including Viewers)</option>
                      <option value="users">Ring Controllers Only</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Announcement Text</label>
                    <textarea 
                      value={announcementText}
                      onChange={(e) => setAnnouncementText(e.target.value)}
                      placeholder="Enter your message here..."
                      className="w-full h-32 px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-3xl text-lg font-bold text-slate-800 focus:border-red-600 focus:ring-0 outline-none transition-all resize-none"
                    />
                  </div>
                  
                  <div className="flex gap-4">
                    <button 
                      onClick={() => {
                        setShowAnnouncementInput(false);
                        setBroadcastModalType('standard');
                      }}
                      className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black uppercase tracking-widest hover:bg-slate-200 transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleSendAnnouncement}
                      disabled={!announcementText.trim()}
                      className="flex-2 py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-red-700 disabled:bg-slate-200 disabled:text-slate-400 transition-all shadow-lg shadow-red-200 cursor-pointer"
                    >
                      Send Broadcast
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-8 space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">From Ring</label>
                      <input 
                        type="text"
                        value={transferFromRing}
                        onChange={(e) => setTransferFromRing(e.target.value)}
                        placeholder="e.g. 1"
                        className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-3xl text-base font-bold text-slate-800 focus:border-red-600 focus:ring-0 outline-none transition-all"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Transfer Ring</label>
                      <input 
                        type="text"
                        value={transferToRing}
                        onChange={(e) => setTransferToRing(e.target.value)}
                        placeholder="e.g. 2"
                        className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-3xl text-base font-bold text-slate-800 focus:border-red-600 focus:ring-0 outline-none transition-all"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Bout Number</label>
                    <input 
                      type="text"
                      value={transferBoutNumber}
                      onChange={(e) => setTransferBoutNumber(e.target.value)}
                      placeholder="e.g. A101"
                      className="w-full px-6 py-4 bg-slate-50 border-2 border-slate-100 rounded-3xl text-base font-bold text-slate-800 focus:border-red-600 focus:ring-0 outline-none transition-all"
                    />
                  </div>
                  
                  <div className="flex gap-4">
                    <button 
                      onClick={() => {
                        setShowAnnouncementInput(false);
                        setBroadcastModalType('standard');
                      }}
                      className="flex-1 py-4 bg-slate-100 text-slate-600 rounded-2xl font-black uppercase tracking-widest hover:bg-slate-200 transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleSendTransferBroadcast}
                      disabled={!transferFromRing.trim() || !transferToRing.trim() || !transferBoutNumber.trim()}
                      className="flex-2 py-4 bg-red-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-red-700 disabled:bg-slate-200 disabled:text-slate-400 transition-all shadow-lg shadow-red-200 cursor-pointer"
                    >
                      Send &amp; Pin (30m)
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {showAddRingModal && (
        <AddRingModal
          onClose={() => setShowAddRingModal(false)}
          onAdd={addRing}
          existingRings={rings.map(r => r.ringNumber)}
          namingMode={ringNamingMode}
        />
      )}

      {showRebootModal && (
        <RebootConfirmModal
          onClose={handleCancelReboot}
          onConfirm={handleConfirmReboot}
          isAdmin={user?.role === 'admin'}
        />
      )}

      {missingBoutPrompt && (
        <MissingBoutModal
          prompt={missingBoutPrompt}
          onClose={() => setMissingBoutPrompt(null)}
          onSubmitReason={handleMissingBoutReason}
          onSubmitManual={handleMissingBoutManual}
          categories={categories}
          clubs={clubs}
          boutNumberingMode={boutNumberingMode}
        />
      )}

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-6 py-3 flex items-center justify-between z-[60] shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        {user?.role === 'admin' && (
          <>
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'dashboard' ? "text-red-600" : "text-slate-400")}
            >
              <LayoutDashboard size={20} />
              <span className="text-[10px] font-bold">Home</span>
            </button>
            <button 
              onClick={() => setActiveTab('mats')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'mats' ? "text-red-600" : "text-slate-400")}
            >
              <Monitor size={20} />
              <span className="text-[10px] font-bold">Rings</span>
            </button>

            <button 
              onClick={() => setActiveTab('ai-setup')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'ai-setup' ? "text-red-600" : "text-slate-400")}
            >
              <RefreshCw size={20} />
              <span className="text-[10px] font-bold">AI Setup</span>
            </button>
            <button 
              onClick={() => setActiveTab('search-winner')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'search-winner' ? "text-red-600" : "text-slate-400")}
            >
              <Search size={20} />
              <span className="text-[10px] font-bold">Search</span>
            </button>
            <button 
              onClick={() => setActiveTab('settings')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'settings' ? "text-red-600" : "text-slate-400")}
            >
              <Settings size={20} />
              <span className="text-[10px] font-bold">System</span>
            </button>
          </>
        )}
        {user?.role === 'user' && (
          <>
            <button 
              onClick={() => setActiveTab('mats')}
              className={cn("flex flex-col items-center gap-1 transition-colors relative", activeTab === 'mats' ? "text-red-600" : "text-slate-400")}
            >
              <div className="relative">
                <LayoutDashboard size={24} />
                <span className="absolute -top-2 -right-2 bg-red-600 text-white text-[8px] font-black px-1.5 py-0.5 rounded-full">
                  {rings.find(r => r.ringNumber === Number(user?.assignedRing))?.totalBouts || 0}
                </span>
              </div>
              <span className="text-[10px] font-bold">Ring {getRingName(Number(user?.assignedRing) || 1)}</span>
            </button>
            <button 
              onClick={() => setActiveTab('search-winner')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'search-winner' ? "text-red-600" : "text-slate-400")}
            >
              <Search size={24} />
              <span className="text-[10px] font-bold">Search</span>
            </button>
            <button 
              onClick={() => setActiveTab('general')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'general' ? "text-red-600" : "text-slate-400")}
            >
              <Monitor size={24} />
              <span className="text-[10px] font-bold">Live</span>
            </button>
          </>
        )}
        {user?.role === 'viewer' && (
          <>
            <button 
              onClick={() => setActiveTab('general')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'general' ? "text-red-600" : "text-slate-400")}
            >
              <Monitor size={24} />
              <span className="text-[10px] font-bold">Onsite</span>
            </button>
            <button 
              onClick={() => setActiveTab('standby')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'standby' ? "text-red-600" : "text-slate-400")}
            >
              <LayoutDashboard size={24} />
              <span className="text-[10px] font-bold">Standby</span>
            </button>
            <button 
              onClick={() => setActiveTab('site_view')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'site_view' ? "text-red-600" : "text-slate-400")}
            >
              <LayoutDashboard size={24} />
              <span className="text-[10px] font-bold">Site</span>
            </button>
            <button 
              onClick={() => setActiveTab('points')}
              className={cn("flex flex-col items-center gap-1 transition-colors", activeTab === 'points' ? "text-red-600" : "text-slate-400")}
            >
              <LayoutDashboard size={24} />
              <span className="text-[10px] font-bold">Points</span>
            </button>
          </>
        )}
      </nav>

      {user?.role === 'admin' && (
        <TournamentAssistant 
          currentEventId={currentEventId}
          events={events}
          rings={rings.filter(r => !r.isDeleted && r.ringNumber <= visibleRingsCount)}
          boutQueue={boutQueue}
          athletes={athletes}
          boutNumberingMode={boutNumberingMode}
        />
      )}
    </div>
  );
}

interface RebootConfirmModalProps {
  onClose: () => void;
  onConfirm: () => void;
  isAdmin: boolean;
}

function RebootConfirmModal({ onClose, onConfirm, isAdmin }: RebootConfirmModalProps) {
  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[999]">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-100"
      >
        <div className="p-6 bg-amber-500 text-white flex items-center gap-4">
          <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center shrink-0">
            <RefreshCw size={24} className="animate-spin" style={{ animationDuration: '6s' }} />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-tight text-white">System Reboot Request</h2>
            <p className="text-xs text-amber-100 font-bold uppercase tracking-widest">Confirmation Needed</p>
          </div>
        </div>
        
        <div className="p-8 space-y-6">
          <div className="space-y-3 text-center sm:text-left">
            <p className="text-slate-700 font-bold text-sm leading-relaxed">
              {isAdmin 
                ? "The system is requesting a page reload/reboot to refresh cloud database connections." 
                : "A system reboot is required to refresh database connections, which must be authorized by an Administrator."}
            </p>
            <p className="text-slate-500 text-xs leading-relaxed">
              {isAdmin 
                ? "As an Admin, do you want to reboot the system now to re-establish cloud database synchronization?" 
                : "Only an Administrator is authorized to confirm this reboot. Please contact an Admin to authorize this action."}
            </p>
          </div>
          
          <div className="flex gap-4">
            <button 
              onClick={onClose}
              className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-black text-xs uppercase tracking-widest transition-colors"
            >
              Cancel
            </button>
            {isAdmin && (
              <button 
                onClick={onConfirm}
                className="flex-1 py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-black text-xs uppercase tracking-widest transition-colors shadow-lg shadow-amber-200"
              >
                Reboot Now
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

interface MissingBoutModalProps {
  prompt: { ringNumber: number; expectedBout: number; totalBouts: number };
  onClose: () => void;
  onSubmitReason: (ringNumber: number, boutNumber: number, reason: string) => void;
  onSubmitManual: (ringNumber: number, data: MatchData) => void;
  categories: string[];
  clubs: string[];
}

function MissingBoutModal({ prompt, onClose, onSubmitReason, onSubmitManual, categories, clubs, boutNumberingMode = 'alphanumeric' }: MissingBoutModalProps & { boutNumberingMode?: 'numeric' | 'alphanumeric' }) {
  const [mode, setMode] = useState<'reason' | 'manual'>('reason');
  const [reason, setReason] = useState('Walkover');
  const [customReason, setCustomReason] = useState('');

  const [manualData, setManualData] = useState<MatchData>(() => {
    const savedCategory = localStorage.getItem('tkd_last_category') || categories[0] || '';
    const savedBlueClub = localStorage.getItem('tkd_last_blue_club') || '';
    const savedRedClub = localStorage.getItem('tkd_last_red_club') || '';
    
    return {
      ring: prompt.ringNumber,
      bout: prompt.expectedBout,
      category: savedCategory,
      blue_name: '',
      blue_club: savedBlueClub,
      red_name: '',
      red_club: savedRedClub,
      privacy_mode: false
    };
  });

  const handleClearMemory = () => {
    localStorage.removeItem('tkd_last_category');
    localStorage.removeItem('tkd_last_blue_club');
    localStorage.removeItem('tkd_last_red_club');
    setManualData(prev => ({
      ...prev,
      category: '',
      blue_club: '',
      red_club: ''
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'reason') {
      const finalReason = reason === 'Other' ? customReason : reason;
      onSubmitReason(prompt.ringNumber, prompt.expectedBout, finalReason);
    } else {
      localStorage.setItem('tkd_last_category', manualData.category);
      localStorage.setItem('tkd_last_blue_club', manualData.blue_club);
      localStorage.setItem('tkd_last_red_club', manualData.red_club);
      onSubmitManual(prompt.ringNumber, manualData);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
          <div>
            <h2 className="text-xl font-black">Queue Empty</h2>
            <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Bout {formatBoutNumber(prompt.ringNumber, prompt.expectedBout, boutNumberingMode)} of {formatBoutNumber(prompt.ringNumber, prompt.totalBouts, boutNumberingMode)}</p>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex bg-slate-100 p-1 rounded-xl">
            <button
              type="button"
              onClick={() => setMode('reason')}
              className={`flex-1 py-2 text-xs font-bold uppercase tracking-widest rounded-lg transition-colors ${mode === 'reason' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Record Reason
            </button>
            <button
              type="button"
              onClick={() => setMode('manual')}
              className={`flex-1 py-2 text-xs font-bold uppercase tracking-widest rounded-lg transition-colors ${mode === 'manual' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Manual Entry
            </button>
          </div>

          <form id="missing-bout-form" onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
            {mode === 'reason' ? (
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  There are no upcoming bouts in the queue for Ring {prompt.ringNumber}. Please provide a reason to skip Bout {prompt.expectedBout} and continue.
                </p>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Reason</label>
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                    autoComplete="off"
                  >
                    <option value="Walkover">Walkover</option>
                    <option value="Player No-Show">Player No-Show</option>
                    <option value="Disqualification">Disqualification</option>
                    <option value="Break / Lunch">Break / Lunch</option>
                    <option value="Other">Other...</option>
                  </select>
                </div>
                {reason === 'Other' && (
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Specify Reason</label>
                    <input
                      type="text"
                      value={customReason}
                      onChange={(e) => setCustomReason(e.target.value)}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                      required
                      placeholder="Enter reason..."
                      autoComplete="off"
                    />
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Category</label>
                  <select
                    value={manualData.category}
                    onChange={(e) => setManualData({...manualData, category: e.target.value})}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                    required
                    autoComplete="off"
                  >
                    <option value="" disabled>Select Category</option>
                    {categories.map((cat, i) => (
                      <option key={`${cat}-${i}`} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-blue-500 uppercase tracking-widest ml-1">Blue Player</label>
                    <input
                      type="text"
                      value={manualData.blue_name}
                      onChange={(e) => setManualData({...manualData, blue_name: e.target.value})}
                      className="w-full px-3 py-2 bg-white border border-blue-200 rounded-xl text-sm font-bold"
                      placeholder="Name"
                      required
                      autoComplete="off"
                    />
                    <select
                      value={manualData.blue_club}
                      onChange={(e) => setManualData({...manualData, blue_club: e.target.value})}
                      className="w-full px-3 py-2 bg-white border border-blue-200 rounded-xl text-sm font-bold"
                      required
                      autoComplete="off"
                    >
                      <option value="" disabled>Select Club</option>
                      {clubs.map((club, i) => (
                        <option key={`${club}-${i}`} value={club}>{club}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-red-500 uppercase tracking-widest ml-1">Red Player</label>
                    <input
                      type="text"
                      value={manualData.red_name}
                      onChange={(e) => setManualData({...manualData, red_name: e.target.value})}
                      className="w-full px-3 py-2 bg-white border border-red-200 rounded-xl text-sm font-bold"
                      placeholder="Name"
                      required
                      autoComplete="off"
                    />
                    <select
                      value={manualData.red_club}
                      onChange={(e) => setManualData({...manualData, red_club: e.target.value})}
                      className="w-full px-3 py-2 bg-white border border-red-200 rounded-xl text-sm font-bold"
                      required
                      autoComplete="off"
                    >
                      <option value="" disabled>Select Club</option>
                      {clubs.map((club, i) => (
                        <option key={`${club}-${i}`} value={club}>{club}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </form>

          <div className="flex gap-3 pt-2">
            {mode === 'manual' && (
              <button
                type="button"
                onClick={handleClearMemory}
                className="px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-black text-xs uppercase tracking-widest transition-colors"
                title="Clear remembered category and clubs"
              >
                Clear Memory
              </button>
            )}
            <button
              type="submit"
              form="missing-bout-form"
              className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 transition-all"
            >
              {mode === 'reason' ? 'Record & Continue' : 'Start Bout'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick, badge }: { icon: React.ReactNode, label: string, active?: boolean, onClick: () => void, badge?: React.ReactNode }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-bold transition-all duration-200",
        active 
          ? "bg-red-50 text-red-600 shadow-sm" 
          : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
      )}
    >
      <div className="flex items-center gap-3">
        {icon}
        {label}
      </div>
      {badge !== undefined && (
        <span className={cn(
          "px-2 py-0.5 rounded-full text-[10px] font-black",
          active ? "bg-red-100 text-red-600" : "bg-slate-200 text-slate-500"
        )}>
          {badge}
        </span>
      )}
    </button>
  );
}

function StatCard({ label, value, trend }: { label: string, value: string, trend: string }) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <h4 className="text-3xl font-black text-slate-800">{value}</h4>
        <span className="text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">{trend}</span>
      </div>
    </div>
  );
}

interface RingCardProps {
  key?: React.Key;
  ring: RingStatus;
  namingMode: 'number' | 'alphabet';
  categories: string[];
  clubs: string[];
  queueCount?: number;
  onUpdate: (data: MatchData) => void;
  onPointsUpdate?: (points: any) => void;
  onUpdateTotalBouts?: (total: number) => void;
  onStart?: () => void;
  onDelete?: () => void;
  onWinnerSelect?: (winner: string) => void;
  isAutoPull?: boolean;
  onToggleAutoPull?: () => void;
  user?: UserAccount | null;
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  layout?: 'winner' | 'point';
  showInspectionPopupSetting?: boolean;
  onReturnToQueue?: () => void;
  onResumeSuspended?: (boutNumber: string | number) => void;
  onRemoveSuspended?: (boutNumber: string | number) => void;
  onSuspendCurrentBout?: () => void;
  transfers?: BoutTransferBroadcast[];
}

interface EditResultModalProps {
  onClose: () => void;
  onSubmit: (ringNumber: number, boutNumber: string | number, winner: 'Blue' | 'Red' | 'Completed' | string) => void;
  rings: RingStatus[];
  queue: { id: string; data: MatchData }[];
  user: UserAccount | null;
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  events: EventData[];
  currentEventId: string | null;
}

function EditResultModal({ onClose, onSubmit, rings, queue, user, boutNumberingMode = 'alphanumeric', events, currentEventId }: EditResultModalProps) {
  const defaultRing = (user?.role === 'admin' || sessionStorage.getItem('user_role') === 'court_clerk' || user?.role === 'user') ? (rings[0]?.ringNumber || 1) : (Number(user?.assignedRing) || 1);
  
  const [formData, setFormData] = useState({
    eventId: currentEventId || '',
    ring: defaultRing,
    bout: '',
    winner: 'Blue' as 'Blue' | 'Red' | 'Completed'
  });

  const [activeBoutNames, setActiveBoutNames] = useState<{blue: string, red: string} | null>(null);
  const [isPoomsae, setIsPoomsae] = useState(false);

  useEffect(() => {
    if (!formData.bout) {
      setActiveBoutNames(null);
      setIsPoomsae(false);
      return;
    }
    const normalized = normalizeBoutNumber(formData.bout);
    // Find names
    let found: MatchData | null = null;
    const ring = rings.find(r => r.ringNumber === formData.ring);
    if (ring) {
      if (ring.currentBout && isBoutMatch(ring.currentBout.bout, normalized) && (ring.currentBout.eventId === formData.eventId || !formData.eventId)) found = ring.currentBout;
      else if (ring.onDeck && isBoutMatch(ring.onDeck.bout, normalized) && (ring.onDeck.eventId === formData.eventId || !formData.eventId)) found = ring.onDeck;
      else if (ring.inTheHole && isBoutMatch(ring.inTheHole.bout, normalized) && (ring.inTheHole.eventId === formData.eventId || !formData.eventId)) found = ring.inTheHole;
    }
    if (!found) {
      const queued = queue.find(q => q.data.ring === formData.ring && isBoutMatch(q.data.bout, normalized) && (q.data.eventId === formData.eventId || !formData.eventId));
      if (queued) found = queued.data;
    }

    if (found) {
      setActiveBoutNames({ blue: found.blue_name, red: found.red_name });
      const poomsaeMode = found.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || false;
      setIsPoomsae(poomsaeMode);
      if (poomsaeMode && formData.winner !== 'Completed') {
        setFormData(prev => ({ ...prev, winner: 'Completed' }));
      } else if (!poomsaeMode && formData.winner === 'Completed') {
        setFormData(prev => ({ ...prev, winner: 'Blue' }));
      }
    } else {
      setActiveBoutNames(null);
      setIsPoomsae(false);
    }
  }, [formData.ring, formData.bout, rings, queue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.bout) return;
    onSubmit(formData.ring, formData.bout, formData.winner);
    onClose();
  };

  const availableRings = (user?.role === 'admin' || sessionStorage.getItem('user_role') === 'court_clerk' || user?.role === 'user') 
    ? rings 
    : rings.filter(r => r.ringNumber === Number(user?.assignedRing));

  const displayRings = availableRings.length > 0 
    ? availableRings 
    : (user?.assignedRing ? [{ ringNumber: Number(user.assignedRing) } as RingStatus] : rings);

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
              <Edit2 size={20} />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight">Edit Result</h2>
              <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Update Winner</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2 col-span-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Event</label>
              <select 
                value={formData.eventId}
                onChange={(e) => setFormData({...formData, eventId: e.target.value})}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
              >
                <option value="">All Events</option>
                {events.map((e, i) => (
                  <option key={`${e.id}-${i}`} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Ring</label>
              <select 
                value={formData.ring || ''}
                onChange={(e) => setFormData({...formData, ring: parseInt(e.target.value)})}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                required
              >
                <option value="" disabled>Select Ring</option>
                {displayRings.map(r => (
                  <option key={r.ringNumber} value={r.ringNumber}>Ring {r.ringNumber}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Bout Number</label>
              <input 
                type="text" 
                value={formData.bout}
                onChange={(e) => setFormData({...formData, bout: e.target.value})}
                onBlur={(e) => {
                  const formatted = formatBoutNumber(formData.ring, e.target.value, boutNumberingMode);
                  setFormData({...formData, bout: formatted});
                }}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Winner</label>
            <select 
              value={formData.winner}
              onChange={(e) => setFormData({...formData, winner: e.target.value as 'Blue' | 'Red' | 'Completed'})}
              className={cn(
                "w-full px-4 py-3 border rounded-xl text-sm font-bold transition-colors",
                formData.winner === 'Blue' ? "bg-blue-50 border-blue-200 text-blue-700" : 
                formData.winner === 'Red' ? "bg-red-50 border-red-200 text-red-700" : 
                "bg-green-50 border-green-200 text-green-700"
              )}
              required
            >
              {isPoomsae ? (
                <option value="Completed">Completed {activeBoutNames ? `(${activeBoutNames.blue})` : ''}</option>
              ) : (
                <>
                  <option value="Blue">Blue Corner {activeBoutNames ? `(${activeBoutNames.blue})` : ''}</option>
                  <option value="Red">Red Corner {activeBoutNames ? `(${activeBoutNames.red})` : ''}</option>
                </>
              )}
            </select>
          </div>

          <button 
            type="submit"
            className="w-full py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-black uppercase tracking-widest text-sm transition-all shadow-lg shadow-slate-200"
          >
            Update Result
          </button>
        </form>
      </motion.div>
    </div>
  );
}

interface FinalBoutCheckModalProps {
  ringNumber: number;
  remainingCount: number;
  onConfirmFinal: () => void;
  onAddBout: () => void;
}

function FinalBoutCheckModal({ ringNumber, remainingCount, onConfirmFinal, onAddBout }: FinalBoutCheckModalProps) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="p-6 bg-red-600 text-white flex items-center gap-4">
          <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center">
            <AlertTriangle size={24} />
          </div>
          <div>
            <h2 className="text-xl font-black tracking-tight">Upcoming Bouts Alert</h2>
            <p className="text-xs text-red-100 font-bold uppercase tracking-widest">Ring {ringNumber}</p>
          </div>
        </div>
        
        <div className="p-8 space-y-6">
          <div className="space-y-2 text-center">
            <p className="text-slate-600 font-medium">
              There are only <span className="text-red-600 font-black">{remainingCount}</span> upcoming bouts remaining for this ring.
            </p>
            <p className="text-sm text-slate-500">
              A minimum of 3 standby bouts is required unless these are the final bouts of the session.
            </p>
          </div>
          
          <div className="flex flex-col gap-3">
            <button 
              onClick={onConfirmFinal}
              className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg shadow-slate-200"
            >
              Yes, these are final bouts
            </button>
            <button 
              onClick={onAddBout}
              className="w-full py-4 bg-white text-slate-900 border-2 border-slate-200 rounded-2xl font-black uppercase tracking-widest hover:bg-slate-50 transition-all"
            >
              No, add more bouts
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

interface NewBoutModalProps {
  onClose: () => void;
  onSubmit: (ringNumber: number, data: MatchData) => void;
  categories: string[];
  clubs: string[];
  rings: RingStatus[];
  queue: { id: string; data: MatchData }[];
  user: UserAccount | null;
  initialRing?: number;
  currentEventId: string | null;
  events: EventData[];
  isSyncing: boolean;
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  matchHistory: MatchHistoryItem[];
}

function NewBoutModal({ onClose, onSubmit, categories, clubs, rings, queue, user, initialRing, currentEventId, events, isSyncing, boutNumberingMode = 'alphanumeric', matchHistory = [] }: NewBoutModalProps) {
  const defaultRing = initialRing || ((user?.role === 'admin' || sessionStorage.getItem('user_role') === 'court_clerk' || user?.role === 'user') ? (rings[0]?.ringNumber || 1) : (Number(user?.assignedRing) || 1));
  
  const getNextBoutNumber = (ringNum: number) => {
    let maxBout = ringNum * 1000;
    let foundAny = false;

    queue.forEach(q => {
      if (q.data.ring === ringNum && q.data.eventId === currentEventId) {
        const normalized = normalizeBoutWithRing(q.data.bout, ringNum);
        const boutNum = parseInt(normalized) || 0;
        if (boutNum > maxBout) {
          maxBout = boutNum;
          foundAny = true;
        }
      }
    });

    const ringStatus = rings.find(r => r.ringNumber === ringNum);
    if (ringStatus?.currentBout && ringStatus.currentBout.eventId === currentEventId) {
      const normalized = normalizeBoutWithRing(ringStatus.currentBout.bout, ringNum);
      const boutNum = parseInt(normalized) || 0;
      if (boutNum > maxBout) {
        maxBout = boutNum;
        foundAny = true;
      }
    }
    
    // Also check nextBoutNumber from ringStatus to ensure we don't reuse completed bouts
    if (ringStatus?.nextBoutNumber) {
      const nextBout = ringStatus.nextBoutNumber < 1000 ? (ringNum * 1000 + ringStatus.nextBoutNumber) : ringStatus.nextBoutNumber;
      if (nextBout > maxBout) {
        maxBout = nextBout - 1; // maxBout is the highest existing, so nextBout - 1
        foundAny = true;
      }
    }
    
    const nextNum = foundAny ? maxBout + 1 : ringNum * 1000 + 1;
    return formatBoutNumber(ringNum, nextNum, boutNumberingMode);
  };

  const [formData, setFormData] = useState<MatchData>(() => {
    return {
      eventId: currentEventId || null,
      ring: defaultRing,
      bout: getNextBoutNumber(defaultRing),
      category: '',
      blue_name: '',
      blue_club: '',
      red_name: '',
      red_club: '',
      privacy_mode: false
    };
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isPoomsaeMode = formData.category?.toUpperCase().includes('INDIVIDUAL POOMSAE');

  const setPoomsaeMode = (checked: boolean) => {
    if (checked) {
      setFormData(prev => ({ ...prev, category: 'INDIVIDUAL POOMSAE' }));
    } else if (formData.category === 'INDIVIDUAL POOMSAE') {
      setFormData(prev => ({ ...prev, category: '' }));
    }
  };

  const handleRingChange = (newRing: number) => {
    setFormData(prev => ({
      ...prev,
      ring: newRing,
      bout: getNextBoutNumber(newRing)
    }));
  };

  const handleClearMemory = () => {
    setFormData(prev => ({
      ...prev,
      category: '',
      blue_club: '',
      red_club: ''
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const targetBout = normalizeBoutWithRing(formData.bout, formData.ring);

    // Check if bout number already exists in queue or current bout for THIS event
    const inQueue = queue.find(q => 
      q.data.ring === formData.ring && 
      normalizeBoutWithRing(q.data.bout, q.data.ring) === targetBout &&
      q.data.eventId === formData.eventId
    );
    
    const inCurrent = rings.find(r => 
      r.ringNumber === formData.ring && 
      r.currentBout && 
      normalizeBoutWithRing(r.currentBout.bout, r.ringNumber) === targetBout &&
      r.currentBout.eventId === formData.eventId
    );
                       
    if (inQueue) {
      setErrorMsg(`Bout ${targetBout} is already in the Waiting Queue for Ring ${formData.ring}.`);
      return;
    }
    if (inCurrent) {
      setErrorMsg(`Bout ${targetBout} is currently the Active Match in Ring ${formData.ring}.`);
      return;
    }
    
    // Update formData with normalized bout number before submitting
    const finalData = { ...formData, bout: targetBout, eventId: formData.eventId || null, allowCompleted: true };
    
    onSubmit(formData.ring, finalData);
    onClose();
  };

  const availableRings = (user?.role === 'admin' || sessionStorage.getItem('user_role') === 'court_clerk' || user?.role === 'user') 
    ? rings 
    : rings.filter(r => r.ringNumber === Number(user?.assignedRing));

  const displayRings = availableRings.length > 0 
    ? availableRings 
    : (user?.assignedRing ? [{ ringNumber: Number(user.assignedRing) } as RingStatus] : rings);

  const targetBoutVal = normalizeBoutWithRing(formData.bout, formData.ring);
  const isAlreadyCompleted = matchHistory.some(h => {
    if (h.eventId !== currentEventId) return false;
    
    // Match 1: Using strict logic with ring combination
    if (normalizeBoutWithRing(h.bout, formData.ring) === targetBoutVal) return true;
    
    // Match 2: Direct raw equality removed to prevent overlapping false positives
    // if (normalizeBoutNumber(h.bout) === normalizeBoutNumber(formData.bout)) return true;
    
    return false;
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden"
      >
        <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
              <Plus size={20} />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight">Create New Bout</h2>
              <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Manual Entry</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6" autoComplete="off">
          {errorMsg && (
            <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm font-bold border border-red-100">
              {errorMsg}
            </div>
          )}
          {isAlreadyCompleted && (
            <div className="bg-amber-50 text-amber-700 p-4 rounded-xl text-xs font-bold border border-amber-100 flex items-center gap-3">
              <AlertTriangle size={18} className="shrink-0 text-amber-500 animate-pulse" />
              <div>
                This bout is already marked as completed. Submitting will add it back to the standby queue to run again.
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2 col-span-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Event</label>
              <select 
                value={formData.eventId || ''}
                onChange={(e) => setFormData({...formData, eventId: e.target.value})}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
              >
                <option value="">All Events</option>
                {events.map((e, i) => (
                  <option key={`${e.id}-${i}`} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Ring</label>
              <select 
                value={isNaN(formData.ring) ? '' : formData.ring}
                onChange={(e) => handleRingChange(parseInt(e.target.value) || 1)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                required
                autoComplete="off"
              >
                {displayRings.map(r => (
                  <option key={r.ringNumber} value={r.ringNumber}>Ring {r.ringNumber}</option>
                ))}
              </select>
            </div>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Bout Number</label>
                  <input 
                    type="text" 
                    value={formData.bout || ''}
                    onChange={(e) => setFormData({...formData, bout: e.target.value})}
                    onBlur={(e) => {
                      const formatted = formatBoutNumber(formData.ring, e.target.value, boutNumberingMode);
                      setFormData({...formData, bout: formatted});
                    }}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                    required
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const boutNumStr = formData.bout.toString();
                    if (!boutNumStr) return;
                    
                    if (isFirestoreQuotaExceeded) {
                      console.warn("Firestore quota exceeded, bypassing getting bracket.");
                      return;
                    }
                    try {
                      // Fetch bracket data from Firestore
                      const bracketRef = doc(db, 'tournaments', currentEventId || 'default', 'bracket', 'data');
                      const bracketSnap = await getDoc(bracketRef);
                      
                      if (bracketSnap.exists()) {
                        const bracketData = bracketSnap.data().matches;
                        if (bracketData && Array.isArray(bracketData)) {
                          const targetNormalized = normalizeBoutWithRing(boutNumStr, formData.ring);
                          const match = bracketData.find(m => normalizeBoutWithRing(m.bout, formData.ring) === targetNormalized);
                          if (match) {
                            setFormData(prev => ({
                              ...prev,
                              category: match.category || prev.category,
                              blue_name: match.blue_name || prev.blue_name,
                              blue_club: match.blue_club || prev.blue_club,
                              red_name: match.red_name || prev.red_name,
                              red_club: match.red_club || prev.red_club,
                            }));
                            setErrorMsg(null);
                          } else {
                            setErrorMsg(`Bout ${boutNumStr} not found in bracket data.`);
                          }
                        }
                      }
                    } catch (err) {
                      console.error("Error auto-filling bout:", err);
                      setErrorMsg("Failed to auto-fill bout data.");
                    }
                  }}
                  className="px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold text-xs transition-colors h-[46px] flex items-center justify-center"
                  title="Auto-fill from bracket data"
                >
                  <Search size={16} />
                </button>
              </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-slate-50 border border-slate-200 rounded-2xl transition-all hover:border-slate-300">
              <input 
                type="checkbox" 
                id="is-poomsae-modal"
                checked={isPoomsaeMode}
                onChange={(e) => setPoomsaeMode(e.target.checked)}
                className="w-5 h-5 rounded-lg border-slate-300 text-red-600 focus:ring-red-500 transition-all cursor-pointer"
              />
              <label htmlFor="is-poomsae-modal" className="flex flex-col cursor-pointer select-none">
                <span className="text-xs font-black text-slate-900 uppercase tracking-tight">Individual Poomsae Mode</span>
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Solo entry (No Red Corner)</span>
              </label>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Category / Weight</label>
              <input 
                type="text" 
                list="new-bout-cats"
                value={formData.category || ''}
                onChange={(e) => setFormData({...formData, category: e.target.value})}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                placeholder="Select or type category (e.g. -45kg)"
                required
                autoComplete="off"
              />
              <datalist id="new-bout-cats">
                {categories.map((cat, i) => <option key={`${cat}-${i}`} value={cat} />)}
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Blue Corner */}
            <div className={cn(
              "p-4 bg-blue-50/50 rounded-2xl border border-blue-100 space-y-3 transition-all",
              isPoomsaeMode ? "col-span-2" : "col-span-1"
            )}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 bg-blue-600 rounded-full" />
                <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest">
                  {isPoomsaeMode ? "Performer Details" : "Blue Corner"}
                </span>
              </div>
              <input 
                type="text" 
                value={formData.blue_name || ''}
                onChange={(e) => setFormData({...formData, blue_name: e.target.value})}
                className="w-full px-3 py-2 bg-white border border-blue-200 rounded-xl text-sm font-bold"
                placeholder={isPoomsaeMode ? "Performer Name" : "Player Name"}
                required
                autoComplete="off"
              />
              <input 
                type="text" 
                list="new-bout-clubs"
                value={formData.blue_club || ''}
                onChange={(e) => setFormData({...formData, blue_club: e.target.value})}
                className="w-full px-3 py-2 bg-white border border-blue-200 rounded-xl text-sm font-bold"
                placeholder="Club Name"
                required
                autoComplete="off"
              />
            </div>

            {/* Red Corner */}
            {!isPoomsaeMode && (
              <div className="p-4 bg-red-50/50 rounded-2xl border border-red-100 space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 bg-red-600 rounded-full" />
                  <span className="text-[10px] font-black text-red-600 uppercase tracking-widest">Red Corner</span>
                </div>
                <input 
                  type="text" 
                  value={formData.red_name || ''}
                  onChange={(e) => setFormData({...formData, red_name: e.target.value})}
                  className="w-full px-3 py-2 bg-white border border-red-200 rounded-xl text-sm font-bold"
                  placeholder="Player Name"
                  required={!isPoomsaeMode}
                  autoComplete="off"
                />
                <input 
                  type="text" 
                  list="new-bout-clubs"
                  value={formData.red_club || ''}
                  onChange={(e) => setFormData({...formData, red_club: e.target.value})}
                  className="w-full px-3 py-2 bg-white border border-red-200 rounded-xl text-sm font-bold"
                  placeholder="Club Name"
                  required={!isPoomsaeMode}
                  autoComplete="off"
                />
              </div>
            )}
          </div>
          <datalist id="new-bout-clubs">
            {clubs.map((club, i) => <option key={`${club}-${i}`} value={club} />)}
          </datalist>

          <div className="pt-4 flex gap-3">
            <button 
              type="submit"
              className="flex-1 py-4 bg-red-600 hover:bg-red-700 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 transition-all flex items-center justify-center gap-2"
            >
              {isSyncing ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  Syncing to Cloud...
                </>
              ) : (
                "Create Bout & Sync"
              )}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

interface AddRingModalProps {
  onClose: () => void;
  onAdd: (ringNumber: number) => void;
  existingRings: number[];
  namingMode: 'number' | 'alphabet';
}

function AddRingModal({ onClose, onAdd, existingRings, namingMode }: AddRingModalProps) {
  const availableRings = Array.from({ length: 20 }, (_, i) => i + 1).filter(r => !existingRings.includes(r));
  const [selectedRing, setSelectedRing] = useState<number>(availableRings[0] || 1);

  useEffect(() => {
    if (availableRings.length > 0 && !availableRings.includes(selectedRing)) {
      setSelectedRing(availableRings[0]);
    }
  }, [availableRings, selectedRing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (availableRings.includes(selectedRing)) {
      onAdd(selectedRing);
      onClose();
    }
  };

  const getRingName = (num: number) => namingMode === 'number' ? num.toString() : String.fromCharCode(64 + num);

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="p-6 bg-slate-900 text-white flex items-center justify-between">
          <h2 className="text-xl font-black">Add New Ring</h2>
          <button type="button" onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {availableRings.length === 0 ? (
            <p className="text-sm text-slate-500 text-center">All 20 rings are already active.</p>
          ) : (
            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Select Ring Number</label>
              <select 
                value={isNaN(selectedRing) ? '' : selectedRing}
                onChange={(e) => setSelectedRing(parseInt(e.target.value) || 1)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500"
              >
                {availableRings.map((r, i) => (
                  <option key={`${r}-${i}`} value={r}>Ring {getRingName(r)}</option>
                ))}
              </select>
            </div>
          )}
          
          <div className="flex gap-3 pt-4">
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-black text-xs uppercase tracking-widest transition-colors"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={availableRings.length === 0}
              className="flex-1 py-3 bg-red-600 hover:bg-red-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 transition-all"
            >
              Add Ring
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function RingCard({ ring, namingMode, categories, clubs, queueCount = 0, onUpdate, onPointsUpdate, onUpdateTotalBouts, onStart, onDelete, onWinnerSelect, currentEventId, onForceSync, isAutoPull, onToggleAutoPull, user, boutNumberingMode = 'alphanumeric', layout = 'winner', showInspectionPopupSetting = true, onReturnToQueue, onResumeSuspended, onRemoveSuspended, onSuspendCurrentBout, transfers = [] }: RingCardProps & { currentEventId?: string | null, onForceSync?: (data: MatchData) => void }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isFinalBoutSelection, setIsFinalBoutSelection] = useState(false);
  const [isSyncingLocal, setIsSyncingLocal] = useState(false);
  const [showInspectionWarning, setShowInspectionWarning] = useState(false);
  const [dismissedBouts, setDismissedBouts] = useState<string[]>([]);
  const [points, setPoints] = useState({ 
    r1Blue: '', r1Red: '', r2Blue: '', r2Red: '', r3Blue: '', r3Red: '',
    r1Winner: '' as 'Blue' | 'Red' | '',
    r2Winner: '' as 'Blue' | 'Red' | '',
    r3Winner: '' as 'Blue' | 'Red' | ''
  });
  const pointsDebounceRef = React.useRef<NodeJS.Timeout>();

  // Use an effect to sync prop changes to local points ONLY if they differ, or upon mount/new bout
  useEffect(() => {
    if (ring.currentBout?.points) {
      setPoints(prev => {
        const next = {
          r1Blue: ring.currentBout!.points?.r1Blue || '',
          r1Red: ring.currentBout!.points?.r1Red || '',
          r2Blue: ring.currentBout!.points?.r2Blue || '',
          r2Red: ring.currentBout!.points?.r2Red || '',
          r3Blue: ring.currentBout!.points?.r3Blue || '',
          r3Red: ring.currentBout!.points?.r3Red || '',
          r1Winner: ring.currentBout!.points?.r1Winner || '',
          r2Winner: ring.currentBout!.points?.r2Winner || '',
          r3Winner: ring.currentBout!.points?.r3Winner || ''
        };
        // Don't update if same object to avoid jumpiness
        if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
        return next;
      });
    } else {
      setPoints({ 
        r1Blue: '', r1Red: '', r2Blue: '', r2Red: '', r3Blue: '', r3Red: '',
        r1Winner: '',
        r2Winner: '',
        r3Winner: ''
      });
    }
  }, [ring.currentBout?.bout, ring.currentBout?.points]);

  const latestPointsRef = React.useRef(points);
  useEffect(() => {
    latestPointsRef.current = points;
  }, [points]);

  const handlePointsUpdate = () => {
    if (pointsDebounceRef.current) clearTimeout(pointsDebounceRef.current);
    pointsDebounceRef.current = setTimeout(() => {
      if (ring.currentBout) {
        if (onPointsUpdate) {
          onPointsUpdate(latestPointsRef.current);
        } else {
          onUpdate({ ...ring.currentBout, points: latestPointsRef.current });
        }
      }
    }, 250); // 250ms debounce to feel responsive while still protecting Google Sheets and Firestore writes from keypress spam
  };
  
  // Only show current bout if it belongs to the current event
  const current = ring.currentBout && ring.currentBout.eventId === currentEventId ? ring.currentBout : null;

  const isPoomsaeMode = current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                        current?.category?.toUpperCase().includes('FREESTYLE') ||
                        (current?.category?.toUpperCase().includes('POOMSAE') && !current.red_name && current.blue_name);

  useEffect(() => {
    if (current) {
      const boutKey = `${currentEventId || 'unknown'}_${ring.ringNumber}_${current.bout}`;
      // Respect user intent: if they already dismissed the warning for this bout, do not show it again
      if (dismissedBouts.includes(boutKey)) {
        setShowInspectionWarning(false);
        return;
      }

      if (isPoomsaeMode) {
        if (!current.blue_inspected) {
          setShowInspectionWarning(true);
        } else {
          setShowInspectionWarning(false);
        }
      } else {
        if (!current.blue_inspected || !current.red_inspected) {
          setShowInspectionWarning(true);
        } else {
          setShowInspectionWarning(false);
        }
      }
    } else {
      setShowInspectionWarning(false);
    }
  }, [current?.bout, current?.blue_inspected, current?.red_inspected, isPoomsaeMode, dismissedBouts, currentEventId, ring.ringNumber]);
  
  const ringName = namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber);
  
  const activeTransfersForRing = (transfers || []).filter(t => {
    if (!t.isPinned) return false;
    const expiry = new Date(t.pinnedUntil);
    if (expiry <= now) return false;
    
    const ringNumStr = ring.ringNumber.toString().trim().toUpperCase();
    const ringNameNorm = ringName.trim().toUpperCase();
    const fromRingNorm = t.fromRing.trim().toUpperCase();
    const toRingNorm = t.toRing.trim().toUpperCase();
    
    return fromRingNorm === ringNumStr || fromRingNorm === ringNameNorm ||
           toRingNorm === ringNumStr || toRingNorm === ringNameNorm;
  });
  
  const progress = ring.totalBouts && current ? Math.min(100, (getBoutNumber(current.bout) / ring.totalBouts) * 100) : 0;

  // Compute round-by-round winners to determine any overall match winner
  const getRoundWinnerForPointLayout = (roundNum: 1 | 2 | 3) => {
    const winnerField = points[`r${roundNum}Winner` as 'r1Winner' | 'r2Winner' | 'r3Winner'];
    if (winnerField === 'Blue' || winnerField === 'Red') {
      return winnerField;
    }
    const blueValStr = points[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'];
    const redValStr = points[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'];
    if (blueValStr !== '' && redValStr !== '') {
      const b = parseInt(blueValStr);
      const r = parseInt(redValStr);
      if (!isNaN(b) && !isNaN(r)) {
        if (b > r) return 'Blue';
        if (r > b) return 'Red';
      }
    }
    return '';
  };

  const r1WinnerComputed = getRoundWinnerForPointLayout(1);
  const r2WinnerComputed = getRoundWinnerForPointLayout(2);
  const r3WinnerComputed = getRoundWinnerForPointLayout(3);

  let blueRoundsWonComputed = 0;
  let redRoundsWonComputed = 0;

  if (r1WinnerComputed === 'Blue') blueRoundsWonComputed++;
  if (r1WinnerComputed === 'Red') redRoundsWonComputed++;
  if (r2WinnerComputed === 'Blue') blueRoundsWonComputed++;
  if (r2WinnerComputed === 'Red') redRoundsWonComputed++;
  if (r3WinnerComputed === 'Blue') blueRoundsWonComputed++;
  if (r3WinnerComputed === 'Red') redRoundsWonComputed++;

  const isBlueMatchWinner = blueRoundsWonComputed >= 2;
  const isRedMatchWinner = redRoundsWonComputed >= 2;

  return (
    <div className="relative bg-white border border-slate-200 rounded-[2.5rem] overflow-hidden shadow-sm hover:border-red-200 transition-colors">
      <div className="p-5 bg-slate-900 flex items-center justify-between text-white border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center font-black text-lg shadow-lg shadow-red-900/40">
            {ringName}
          </div>
          <div>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-bold text-sm uppercase tracking-wider block leading-none">Ring {ringName}</span>
              {current && (() => {
                const isTransferred = (() => {
                  if (!current?.bout) return false;
                  const s = current.bout.toString().toUpperCase().trim();
                  const match = s.match(/^([A-Z])/);
                  if (match) {
                    const boutPrefix = match[1];
                    const expectedPrefix = String.fromCharCode(64 + ring.ringNumber);
                    return boutPrefix !== expectedPrefix;
                  }
                  return false;
                })();
                const formBout = formatBoutNumber(ring.ringNumber, current.bout, boutNumberingMode);
                return (
                  <span className="text-[26px] font-black text-slate-300 uppercase tracking-widest border border-slate-700 bg-slate-800 rounded-lg px-3 py-1 leading-none">
                    {formBout}
                    {!isTransferred && ring.totalBouts ? ` / ${formatBoutNumber(ring.ringNumber, ring.totalBouts, boutNumberingMode)}` : ''}
                  </span>
                );
              })()}
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              {ring.totalBouts && (
                <span className="flex items-center gap-1">
                  {onUpdateTotalBouts && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); onUpdateTotalBouts(ring.totalBouts! + 1); }}
                      className="p-0.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 transition-colors"
                      title="Add 1 bout to total"
                    >
                      <Plus size={10} />
                    </button>
                  )}
                </span>
              )}
              {current && onForceSync && (
                <button 
                  onClick={async (e) => {
                    e.stopPropagation();
                    setIsSyncingLocal(true);
                    await onForceSync(current);
                    setIsSyncingLocal(false);
                  }}
                  disabled={isSyncingLocal}
                  className="text-[9px] font-black text-blue-400 hover:text-blue-300 uppercase tracking-widest flex items-center gap-1 disabled:opacity-50"
                  title="Force sync this bout to Google Sheets"
                >
                  <RefreshCw size={10} className={isSyncingLocal ? "animate-spin" : ""} />
                  {isSyncingLocal ? "Syncing..." : "Sync"}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {current && onReturnToQueue && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onReturnToQueue();
              }}
              className="px-2.5 py-1 bg-amber-500/25 border border-amber-500/35 text-amber-400 hover:bg-amber-500/35 rounded text-[10px] font-black uppercase tracking-widest transition-all duration-200 flex items-center gap-1.5 active:scale-95 cursor-pointer shadow-sm text-center"
              title="Return current active bout back to the upcoming bout standby queue"
            >
              <RotateCcw size={11} strokeWidth={3} />
              Return to Queue
            </button>
          )}
          {current && onSuspendCurrentBout && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSuspendCurrentBout();
              }}
              className="px-2.5 py-1 bg-yellow-500/25 border border-yellow-500/35 text-yellow-500 hover:bg-yellow-500/35 rounded text-[10px] font-black uppercase tracking-widest transition-all duration-200 flex items-center gap-1.5 active:scale-95 cursor-pointer shadow-sm text-center"
              title="Pause and suspend this match into the suspended list"
            >
              <Pause size={11} strokeWidth={3} />
              Suspend
            </button>
          )}
          {onToggleAutoPull && (
            <button
              onClick={onToggleAutoPull}
              className={`px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest transition-colors ${isAutoPull ? 'bg-green-500/20 text-green-400' : 'bg-slate-800 text-slate-400'}`}
              title={isAutoPull ? "Auto-pull is ON" : "Auto-pull is OFF"}
            >
              {isAutoPull ? "Auto" : "Manual"}
            </button>
          )}
          {onDelete && (
            <div className="flex items-center">
              {isConfirmingDelete ? (
                <div className="flex items-center gap-1 bg-red-600 rounded px-1 py-0.5 mr-1">
                  <button 
                    onClick={onDelete}
                    className="text-[8px] font-black uppercase hover:underline"
                  >
                    Confirm
                  </button>
                  <button 
                    onClick={() => setIsConfirmingDelete(false)}
                    className="text-[8px] font-black uppercase opacity-50 hover:opacity-100"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button 
                  onClick={() => setIsConfirmingDelete(true)}
                  className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-500 rounded transition-colors mr-1"
                  title="Delete Ring"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          )}
          {!current && (
            <button 
              onClick={onStart}
              className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-[10px] font-bold uppercase transition-colors"
            >
              Start Ring
            </button>
          )}
        </div>
      </div>

      {activeTransfersForRing.map(t => (
        <div 
          key={t.id} 
          className="bg-yellow-500 text-slate-950 px-5 py-3 flex items-center justify-between gap-3 font-bold text-xs uppercase animate-pulse border-b border-yellow-400"
        >
          <span className="flex items-center gap-2">
            <Bell size={14} className="shrink-0 text-slate-950 animate-bounce" />
            <span>Bout Transfer Notice: Ring {t.fromRing} ➡️ Ring {t.toRing} - Bout {t.boutNumber}</span>
          </span>
        </div>
      ))}

      {ring.totalBouts && (
        <div className="h-1 bg-slate-800 w-full relative z-10">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            className="h-full bg-red-600"
          />
        </div>
      )}
      
      <div className="p-8 space-y-8 pt-0 mt-8">
        {current ? (
          <>
            <div className="space-y-6">
              <div className="flex items-start justify-between pb-2">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Shield size={18} className={current.privacy_mode ? "text-red-500" : "text-green-500"} />
                    <span className="text-[16px] font-bold text-slate-500 uppercase">{cleanPlaceholder(current.category)}</span>
                  </div>
                  {current.privacy_mode && (
                    <span className="text-[10px] font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded w-fit inline-block">PDPA ACTIVE</span>
                  )}
                </div>
                <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded uppercase flex items-center gap-1.5 shadow-sm">
                  Live <div className="w-1.5 h-1.5 bg-red-600 rounded-full animate-pulse" />
                </span>
              </div>
              
              <div className="flex items-start gap-4">
                <FighterSide color="blue" name={cleanPlaceholder(current.blue_name)} club={cleanPlaceholder(current.blue_club)} privacy={current.privacy_mode} inspected={current.blue_inspected} />
                {!isPoomsaeMode && (
                  <>
                    <div className="text-xs font-black text-slate-300 italic mt-6">VS</div>
                    <FighterSide color="red" name={cleanPlaceholder(current.red_name)} club={cleanPlaceholder(current.red_club)} privacy={current.privacy_mode} inspected={current.red_inspected} />
                  </>
                )}
              </div>
              
              {/* Category section migrated above */}

              {onWinnerSelect && (
                <div className="pt-6 border-t border-slate-100">
                  {isPoomsaeMode ? (
                    <div className="space-y-4">
                      <p className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest">Poomsae Performance</p>
                      <button 
                        onClick={() => onWinnerSelect('Completed')}
                        className="w-full py-4 bg-green-600 hover:bg-green-700 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-green-200 transition-all active:scale-95 flex items-center justify-center gap-2"
                      >
                        <CheckCircle2 size={18} />
                        Mark as Completed
                      </button>
                    </div>
                  ) : (
                    layout === 'point' ? (
                      <>
                        <p className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Round Points & Winners</p>
                        <div className="grid grid-cols-4 gap-2 mb-4 items-center">
                          <div className="flex items-center justify-center font-bold text-slate-400"></div>
                          <div className="text-center text-[10px] font-black uppercase text-slate-500">R1</div>
                          <div className="text-center text-[10px] font-black uppercase text-slate-500">R2</div>
                          <div className="text-center text-[10px] font-black uppercase text-slate-500">R3</div>
                          
                          <div className="flex items-center justify-center font-black text-[#00a2e8] text-sm uppercase">Blue</div>
                          <input 
                            type="number" 
                            className={cn(
                              "w-12 h-12 text-center border-2 border-[#00a2e8] transition-all font-black text-lg focus:outline-none focus:ring-2 focus:ring-[#00a2e8] mx-auto flex items-center justify-center rounded-full", 
                              (points.r1Winner === 'Blue' || (points.r1Winner === '' && points.r1Blue !== '' && points.r1Red !== '' && parseInt(points.r1Blue) > parseInt(points.r1Red))) 
                                ? "bg-[#00a2e8] text-white scale-110 shadow-md ring-4 ring-blue-300 border-transparent" 
                                : "bg-white text-slate-800"
                            )} 
                            value={points.r1Blue || ''} 
                            onChange={(e) => { 
                              const val = e.target.value; 
                              setPoints(p => {
                                let winner = p.r1Winner;
                                if (val !== '' && p.r1Red !== '') {
                                  const b = parseInt(val);
                                  const r = parseInt(p.r1Red);
                                  if (!isNaN(b) && !isNaN(r)) {
                                    if (b > r) winner = 'Blue';
                                    else if (r > b) winner = 'Red';
                                  }
                                } else if (val === '' && p.r1Red === '') {
                                  winner = '';
                                }
                                return { ...p, r1Blue: val, r1Winner: winner };
                              }); 
                              handlePointsUpdate(); 
                            }} 
                          />
                          <input 
                            type="number" 
                            className={cn(
                              "w-12 h-12 text-center border-2 border-[#00a2e8] transition-all font-black text-lg focus:outline-none focus:ring-2 focus:ring-[#00a2e8] mx-auto flex items-center justify-center rounded-full", 
                              (points.r2Winner === 'Blue' || (points.r2Winner === '' && points.r2Blue !== '' && points.r2Red !== '' && parseInt(points.r2Blue) > parseInt(points.r2Red))) 
                                ? "bg-[#00a2e8] text-white scale-110 shadow-md ring-4 ring-blue-300 border-transparent" 
                                : "bg-white text-slate-800"
                            )} 
                            value={points.r2Blue || ''} 
                            onChange={(e) => { 
                              const val = e.target.value; 
                              setPoints(p => {
                                let winner = p.r2Winner;
                                if (val !== '' && p.r2Red !== '') {
                                  const b = parseInt(val);
                                  const r = parseInt(p.r2Red);
                                  if (!isNaN(b) && !isNaN(r)) {
                                    if (b > r) winner = 'Blue';
                                    else if (r > b) winner = 'Red';
                                  }
                                } else if (val === '' && p.r2Red === '') {
                                  winner = '';
                                }
                                return { ...p, r2Blue: val, r2Winner: winner };
                              }); 
                              handlePointsUpdate(); 
                            }} 
                          />
                          <input 
                            type="number" 
                            className={cn(
                              "w-12 h-12 text-center border-2 border-[#00a2e8] transition-all font-black text-lg focus:outline-none focus:ring-2 focus:ring-[#00a2e8] mx-auto flex items-center justify-center rounded-full", 
                              (points.r3Winner === 'Blue' || (points.r3Winner === '' && points.r3Blue !== '' && points.r3Red !== '' && parseInt(points.r3Blue) > parseInt(points.r3Red))) 
                                ? "bg-[#00a2e8] text-white scale-110 shadow-md ring-4 ring-blue-300 border-transparent" 
                                : "bg-white text-slate-800"
                            )} 
                            value={points.r3Blue || ''} 
                            onChange={(e) => { 
                              const val = e.target.value; 
                              setPoints(p => {
                                let winner = p.r3Winner;
                                if (val !== '' && p.r3Red !== '') {
                                  const b = parseInt(val);
                                  const r = parseInt(p.r3Red);
                                  if (!isNaN(b) && !isNaN(r)) {
                                    if (b > r) winner = 'Blue';
                                    else if (r > b) winner = 'Red';
                                  }
                                } else if (val === '' && p.r3Red === '') {
                                  winner = '';
                                }
                                return { ...p, r3Blue: val, r3Winner: winner };
                              }); 
                              handlePointsUpdate(); 
                            }} 
                          />
                          
                          <div className="flex items-center justify-center font-black text-[#ed1c24] text-sm uppercase">Red</div>
                          <input 
                            type="number" 
                            className={cn(
                              "w-12 h-12 text-center border-2 border-[#ed1c24] transition-all font-black text-lg focus:outline-none focus:ring-2 focus:ring-[#ed1c24] mx-auto flex items-center justify-center rounded-full", 
                              (points.r1Winner === 'Red' || (points.r1Winner === '' && points.r1Red !== '' && points.r1Blue !== '' && parseInt(points.r1Red) > parseInt(points.r1Blue))) 
                                ? "bg-[#ed1c24] text-white scale-110 shadow-md ring-4 ring-red-300 border-transparent" 
                                : "bg-white text-slate-800"
                            )} 
                            value={points.r1Red || ''} 
                            onChange={(e) => { 
                              const val = e.target.value; 
                              setPoints(p => {
                                let winner = p.r1Winner;
                                if (val !== '' && p.r1Blue !== '') {
                                  const r = parseInt(val);
                                  const b = parseInt(p.r1Blue);
                                  if (!isNaN(b) && !isNaN(r)) {
                                    if (b > r) winner = 'Blue';
                                    else if (r > b) winner = 'Red';
                                  }
                                } else if (val === '' && p.r1Blue === '') {
                                  winner = '';
                                }
                                return { ...p, r1Red: val, r1Winner: winner };
                              }); 
                              handlePointsUpdate(); 
                            }} 
                          />
                          <input 
                            type="number" 
                            className={cn(
                              "w-12 h-12 text-center border-2 border-[#ed1c24] transition-all font-black text-lg focus:outline-none focus:ring-2 focus:ring-[#ed1c24] mx-auto flex items-center justify-center rounded-full", 
                              (points.r2Winner === 'Red' || (points.r2Winner === '' && points.r2Red !== '' && points.r2Blue !== '' && parseInt(points.r2Red) > parseInt(points.r2Blue))) 
                                ? "bg-[#ed1c24] text-white scale-110 shadow-md ring-4 ring-red-300 border-transparent" 
                                : "bg-white text-slate-800"
                            )} 
                            value={points.r2Red || ''} 
                            onChange={(e) => { 
                              const val = e.target.value; 
                              setPoints(p => {
                                let winner = p.r2Winner;
                                if (val !== '' && p.r2Blue !== '') {
                                  const r = parseInt(val);
                                  const b = parseInt(p.r2Blue);
                                  if (!isNaN(b) && !isNaN(r)) {
                                    if (b > r) winner = 'Blue';
                                    else if (r > b) winner = 'Red';
                                  }
                                } else if (val === '' && p.r2Blue === '') {
                                  winner = '';
                                }
                                return { ...p, r2Red: val, r2Winner: winner };
                              }); 
                              handlePointsUpdate(); 
                            }} 
                          />
                          <input 
                            type="number" 
                            className={cn(
                              "w-12 h-12 text-center border-2 border-[#ed1c24] transition-all font-black text-lg focus:outline-none focus:ring-2 focus:ring-[#ed1c24] mx-auto flex items-center justify-center rounded-full", 
                              (points.r3Winner === 'Red' || (points.r3Winner === '' && points.r3Red !== '' && points.r3Blue !== '' && parseInt(points.r3Red) > parseInt(points.r3Blue))) 
                                ? "bg-[#ed1c24] text-white scale-110 shadow-md ring-4 ring-red-300 border-transparent" 
                                : "bg-white text-slate-800"
                            )} 
                            value={points.r3Red || ''} 
                            onChange={(e) => { 
                              const val = e.target.value; 
                              setPoints(p => {
                                let winner = p.r3Winner;
                                if (val !== '' && p.r3Blue !== '') {
                                  const r = parseInt(val);
                                  const b = parseInt(p.r3Blue);
                                  if (!isNaN(b) && !isNaN(r)) {
                                    if (b > r) winner = 'Blue';
                                    else if (r > b) winner = 'Red';
                                  }
                                } else if (val === '' && p.r3Blue === '') {
                                  winner = '';
                                }
                                return { ...p, r3Red: val, r3Winner: winner };
                              }); 
                              handlePointsUpdate(); 
                            }} 
                          />

                          {/* Round Winner Selectors Row */}
                          <div className="flex items-center justify-center font-black text-slate-400 text-[10px] uppercase text-center leading-tight">Winner</div>
                          {/* R1 Selector */}
                          <div className="flex justify-center items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = points.r1Winner === 'Blue' ? '' : 'Blue';
                                setPoints(p => ({ ...p, r1Winner: newVal }));
                                handlePointsUpdate();
                              }}
                              className={cn(
                                "h-7 w-7 text-[10px] font-black rounded-lg transition-all flex items-center justify-center",
                                points.r1Winner === 'Blue'
                                  ? "bg-[#00a2e8] text-white shadow-md shadow-blue-500/20 ring-2 ring-blue-300"
                                  : "bg-slate-50 text-slate-500 hover:bg-blue-50 hover:text-[#00a2e8] border border-slate-200"
                              )}
                              title="Set Blue as R1 Winner"
                            >
                              B
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = points.r1Winner === 'Red' ? '' : 'Red';
                                setPoints(p => ({ ...p, r1Winner: newVal }));
                                handlePointsUpdate();
                              }}
                              className={cn(
                                "h-7 w-7 text-[10px] font-black rounded-lg transition-all flex items-center justify-center",
                                points.r1Winner === 'Red'
                                  ? "bg-[#ed1c24] text-white shadow-md shadow-red-500/20 ring-2 ring-red-300"
                                  : "bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-[#ed1c24] border border-slate-200"
                              )}
                              title="Set Red as R1 Winner"
                            >
                              R
                            </button>
                          </div>
                          {/* R2 Selector */}
                          <div className="flex justify-center items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = points.r2Winner === 'Blue' ? '' : 'Blue';
                                setPoints(p => ({ ...p, r2Winner: newVal }));
                                handlePointsUpdate();
                              }}
                              className={cn(
                                "h-7 w-7 text-[10px] font-black rounded-lg transition-all flex items-center justify-center",
                                points.r2Winner === 'Blue'
                                  ? "bg-[#00a2e8] text-white shadow-md shadow-blue-500/20 ring-2 ring-blue-300"
                                  : "bg-slate-50 text-slate-500 hover:bg-blue-50 hover:text-[#00a2e8] border border-slate-200"
                              )}
                              title="Set Blue as R2 Winner"
                            >
                              B
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = points.r2Winner === 'Red' ? '' : 'Red';
                                setPoints(p => ({ ...p, r2Winner: newVal }));
                                handlePointsUpdate();
                              }}
                              className={cn(
                                "h-7 w-7 text-[10px] font-black rounded-lg transition-all flex items-center justify-center",
                                points.r2Winner === 'Red'
                                  ? "bg-[#ed1c24] text-white shadow-md shadow-red-500/20 ring-2 ring-red-300"
                                  : "bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-[#ed1c24] border border-slate-200"
                              )}
                              title="Set Red as R2 Winner"
                            >
                              R
                            </button>
                          </div>
                          {/* R3 Selector */}
                          <div className="flex justify-center items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = points.r3Winner === 'Blue' ? '' : 'Blue';
                                setPoints(p => ({ ...p, r3Winner: newVal }));
                                handlePointsUpdate();
                              }}
                              className={cn(
                                "h-7 w-7 text-[10px] font-black rounded-lg transition-all flex items-center justify-center",
                                points.r3Winner === 'Blue'
                                  ? "bg-[#00a2e8] text-white shadow-md shadow-blue-500/20 ring-2 ring-blue-300"
                                  : "bg-slate-50 text-slate-500 hover:bg-blue-50 hover:text-[#00a2e8] border border-slate-200"
                              )}
                              title="Set Blue as R3 Winner"
                            >
                              B
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = points.r3Winner === 'Red' ? '' : 'Red';
                                setPoints(p => ({ ...p, r3Winner: newVal }));
                                handlePointsUpdate();
                              }}
                              className={cn(
                                "h-7 w-7 text-[10px] font-black rounded-lg transition-all flex items-center justify-center",
                                points.r3Winner === 'Red'
                                  ? "bg-[#ed1c24] text-white shadow-md shadow-red-500/20 ring-2 ring-red-300"
                                  : "bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-[#ed1c24] border border-slate-200"
                              )}
                              title="Set Red as R3 Winner"
                            >
                              R
                            </button>
                          </div>
                        </div>
                        <div className="flex gap-4">
                          <button 
                            onClick={() => onWinnerSelect('Blue')}
                            disabled={isRedMatchWinner}
                            className={cn(
                              "flex-[1] py-3 bg-[#00a2e8] text-white rounded-xl font-black text-sm uppercase transition-all shadow-md px-2 break-words text-center",
                              isRedMatchWinner 
                                ? "opacity-30 cursor-not-allowed pointer-events-none" 
                                : "hover:shadow-[#00a2e8]/20 hover:shadow-lg active:scale-95"
                            )}
                          >
                            Mark {cleanPlaceholder(current.blue_name) || 'Blue'} Win
                          </button>
                          <button 
                            onClick={() => onWinnerSelect('Red')}
                            disabled={isBlueMatchWinner}
                            className={cn(
                              "flex-[1] py-3 bg-[#ed1c24] text-white rounded-xl font-black text-sm uppercase transition-all shadow-md px-2 break-words text-center",
                              isBlueMatchWinner 
                                ? "opacity-30 cursor-not-allowed pointer-events-none" 
                                : "hover:shadow-[#ed1c24]/20 hover:shadow-lg active:scale-95"
                            )}
                          >
                            Mark {cleanPlaceholder(current.red_name) || 'Red'} Win
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-center text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Select Winner</p>
                        <div className="flex gap-4 mb-4">
                          <button 
                            onClick={() => onWinnerSelect('Blue')}
                            className="flex-[1.2] min-h-[4.5rem] sm:min-h-[6rem] py-3 sm:py-4 bg-blue-50 text-[#00a2e8] hover:bg-[#00a2e8] hover:text-white rounded-[1.5rem] font-black text-sm sm:text-lg md:text-[20px] uppercase transition-all border-2 border-blue-200 hover:border-[#00a2e8] active:scale-95 px-2 sm:px-4 break-words whitespace-normal flex items-center justify-center text-center leading-tight shadow-sm hover:shadow-xl hover:shadow-blue-200/50"
                          >
                            <span>{cleanPlaceholder(current.blue_name) || 'Blue'} Wins</span>
                          </button>
                          <button 
                            onClick={() => onWinnerSelect('Red')}
                            className="flex-[1.2] min-h-[4.5rem] sm:min-h-[6rem] py-3 sm:py-4 bg-red-50 text-[#ed1c24] hover:bg-[#ed1c24] hover:text-white rounded-[1.5rem] font-black text-sm sm:text-lg md:text-[20px] uppercase transition-all border-2 border-red-200 hover:border-[#ed1c24] active:scale-95 px-2 sm:px-4 break-words whitespace-normal flex items-center justify-center text-center leading-tight shadow-sm hover:shadow-xl hover:shadow-red-200/50"
                          >
                            <span>{cleanPlaceholder(current.red_name) || 'Red'} Wins</span>
                          </button>
                        </div>
                      </>
                    )
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="py-12 flex flex-col items-center justify-center text-center space-y-4">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center text-slate-300">
              <Trophy size={32} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-bold text-slate-800">Ring is currently inactive</p>
              <p className="text-xs text-slate-500">Set total bouts and start the session</p>
            </div>
            
            <div className="w-full max-w-[200px] space-y-4">
              <div className="space-y-1 text-left">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Total Bouts Today</label>
                {(() => {
                  const isSessionInProgress = ring.nextBoutNumber && ring.nextBoutNumber > 1 && ring.totalBouts && ring.nextBoutNumber <= ring.totalBouts;
                  return (
                    <>
                      <div className="flex items-center gap-2">
                        <input 
                          type="number" 
                          value={ring.totalBouts || ''}
                          onChange={(e) => onUpdateTotalBouts?.(parseInt(e.target.value) || 0)}
                          disabled={!!isSessionInProgress}
                          className={cn(
                            "w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-center",
                            isSessionInProgress && "opacity-50 cursor-not-allowed bg-slate-100"
                          )}
                          placeholder="e.g. 50"
                        />
                        {isSessionInProgress && (
                          <button 
                            type="button"
                            onClick={() => onUpdateTotalBouts?.((ring.totalBouts || 0) + 1)}
                            className="p-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl transition-colors flex-shrink-0"
                            title="Add 1 bout"
                          >
                            <Plus size={20} />
                          </button>
                        )}
                      </div>
                      {isSessionInProgress && (
                        <p className="text-[9px] text-red-500 font-bold uppercase mt-1 text-center">
                          Finish current session ({formatBoutNumber(ring.ringNumber, ring.nextBoutNumber - 1, boutNumberingMode)}/{formatBoutNumber(ring.ringNumber, ring.totalBouts, boutNumberingMode)}) to change
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
              
              {(!ring.totalBouts || ring.totalBouts < 3 || queueCount < 3) && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={isFinalBoutSelection}
                    onChange={(e) => setIsFinalBoutSelection(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                  />
                  <span className="text-xs font-bold text-slate-600">Final bout selection</span>
                </label>
              )}

              <button 
                onClick={onStart}
                disabled={!ring.totalBouts || ((ring.totalBouts < 3 || queueCount < 3) && !isFinalBoutSelection)}
                className="w-full py-3 bg-red-600 hover:bg-red-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-200 transition-all"
              >
                Start Ring Session
              </button>
            </div>
          </div>
        )}
      </div>

      {showInspectionPopupSetting && showInspectionWarning && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-sm">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-2xl overflow-hidden max-w-[280px] w-full"
          >
            <div className="p-4 text-center space-y-3">
              <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto">
                <AlertTriangle size={24} />
              </div>
              <div>
                <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight">Inspection Required</h3>
                <p className="text-[10px] font-bold text-slate-500 mt-1 leading-relaxed">
                  {isPoomsaeMode 
                    ? "The competitor has not passed inspection. Please ensure they are inspected before starting the bout."
                    : "One or both players have not passed inspection. Please ensure they are inspected before starting the bout."}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowInspectionWarning(false);
                  if (current) {
                    const boutKey = `${currentEventId || 'unknown'}_${ring.ringNumber}_${current.bout}`;
                    setDismissedBouts(prev => [...prev, boutKey]);
                  }
                }}
                className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-colors"
              >
                Acknowledge
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {ring.suspendedBouts && ring.suspendedBouts.length > 0 && (
        <div className="p-5 bg-amber-50/60 border-t border-amber-100">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-black text-amber-800 uppercase tracking-wider flex items-center gap-1.5">
              <span className="flex h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              Suspended Matches ({ring.suspendedBouts.length})
            </span>
          </div>
          <div className="space-y-3">
            {ring.suspendedBouts.map((bout, idx) => {
              const bNo = formatBoutNumber(ring.ringNumber, bout.bout, boutNumberingMode);
              return (
                <div 
                  key={`${bout.bout}_${idx}`} 
                  className="p-3 bg-white border border-amber-200/60 rounded-2xl flex items-center justify-between shadow-sm hover:border-amber-400 transition-colors"
                >
                  <div className="flex-1 min-w-0 pr-2 text-left">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-black uppercase text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-md">
                        Bout {bNo}
                      </span>
                      <span className="text-[9px] font-black uppercase text-slate-500 truncate max-w-[150px]" title={bout.category}>
                        {bout.category}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#00a2e8]" />
                        <span className="text-[11px] font-black text-slate-800 truncate">
                          {bout.privacy_mode ? "---" : cleanPlaceholder(bout.blue_name)}
                        </span>
                        <span className="text-[9px] font-black text-[#00a2e8] uppercase">
                          ({cleanPlaceholder(bout.blue_club)})
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#ed1c24]" />
                        <span className="text-[11px] font-black text-slate-800 truncate">
                          {bout.privacy_mode ? "---" : cleanPlaceholder(bout.red_name)}
                        </span>
                        <span className="text-[9px] font-black text-[#ed1c24] uppercase">
                          ({cleanPlaceholder(bout.red_club)})
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {onResumeSuspended && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onResumeSuspended(bout.bout);
                        }}
                        className="p-2 bg-amber-500 text-white hover:bg-amber-600 rounded-xl transition-all active:scale-95 flex items-center justify-center cursor-pointer shadow-md shadow-amber-200"
                        title="Resume: Send back to Active Ring"
                      >
                        <Play size={12} className="fill-current text-white" strokeWidth={3} />
                      </button>
                    )}
                    {onRemoveSuspended && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveSuspended(bout.bout);
                        }}
                        className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all active:scale-95 flex items-center justify-center cursor-pointer"
                        title="Dismiss/Delete Suspended Bout"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FighterSide({ color, name, club, privacy, inspected }: { color: 'blue' | 'red', name: string, club: string, privacy: boolean, inspected?: boolean }) {
  const getDynamicFontSize = (name: string) => {
    const len = name.length;
    if (len <= 15) return 'text-[18px]';
    if (len <= 25) return 'text-[16px]';
    if (len <= 35) return 'text-[14px]';
    return 'text-[12px]';
  };

  return (
    <div className="flex-1 space-y-1">
      <div className={cn(
        "flex items-center gap-1 text-[11px] font-black uppercase tracking-widest mb-1",
        inspected 
          ? (color === 'blue' ? "text-[#00a2e8]" : "text-[#ed1c24]")
          : "text-slate-400"
      )}>
        INSPECTION {inspected ? <Check size={12} strokeWidth={4} /> : <X size={12} strokeWidth={4} />}
      </div>
      <div className={cn(
        "h-1 w-full rounded-full mb-2",
        color === 'blue' ? "bg-[#00a2e8]" : "bg-[#ed1c24]"
      )} />
      <p className={cn(
        "font-black text-slate-800 leading-tight line-clamp-3 whitespace-normal break-words",
        getDynamicFontSize(privacy ? "---" : cleanPlaceholder(name))
      )}>
        {privacy ? "---" : cleanPlaceholder(name)}
      </p>
      <p className={cn(
        "text-[15px] font-bold uppercase",
        color === 'blue' ? "text-[#00a2e8]" : "text-[#ed1c24]"
      )}>{cleanPlaceholder(club)}</p>
    </div>
  );
}

function QueueItem({ label, data }: { label: string, data: MatchData | null }) {
  return (
    <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
      <p className="text-[9px] font-bold text-slate-400 uppercase mb-1">{label}</p>
      {data ? (
        <div className="space-y-0.5">
          <p className="text-[10px] font-bold text-slate-700 truncate">
            {data.privacy_mode ? "---" : data.blue_name} vs {data.privacy_mode ? "---" : data.red_name}
          </p>
          <p className="text-[8px] font-medium text-yellow-200 uppercase">{data.blue_club} / {data.red_club}</p>
        </div>
      ) : (
        <p className="text-[10px] font-medium text-slate-300">TBD</p>
      )}
    </div>
  );
}

function IntegrationCard({ title, description, icon }: { title: string, description: string, icon: React.ReactNode }) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 flex items-center gap-4 shadow-sm hover:shadow-md transition-all cursor-pointer">
      <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center">
        {icon}
      </div>
      <div>
        <h4 className="font-bold text-slate-800">{title}</h4>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      <ChevronRight className="ml-auto text-slate-300" size={20} />
    </div>
  );
}

interface AthleteRowProps {
  key?: React.Key;
  name: string;
  ic: string;
  club: string;
  category: string;
  status: 'Verified' | 'Pending';
}

function AthleteRow({ name, ic, club, category, status }: AthleteRowProps) {
  return (
    <tr className="group hover:bg-slate-50 transition-colors">
      <td className="py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 font-bold text-xs">
            {name.charAt(0)}
          </div>
          <span className="font-bold text-slate-700">{name}</span>
        </div>
      </td>
      <td className="py-4 font-mono text-xs text-slate-500">{ic}</td>
      <td className="py-4 font-bold text-yellow-200">{club}</td>
      <td className="py-4 text-xs font-medium text-slate-500">{category}</td>
      <td className="py-4">
        <span className={cn(
          "px-2 py-1 rounded-full text-[10px] font-bold uppercase",
          status === 'Verified' ? "bg-green-50 text-green-600" : "bg-amber-50 text-amber-600"
        )}>
          {status}
        </span>
      </td>
      <td className="py-4 text-right">
        <button className="p-2 text-slate-300 hover:text-slate-600 transition-colors">
          <ChevronRight size={18} />
        </button>
      </td>
    </tr>
  );
}

interface PublicRingCardProps {
  key?: React.Key;
  ring: RingStatus;
  namingMode: 'number' | 'alphabet';
  queueCount?: number;
  showTotalBouts?: boolean;
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  ringQueue?: {id: string, data: MatchData}[];
  showPublicStandbyQueue?: boolean;
  showEmptyBoutAsInactive?: boolean;
  publicViewLayout?: 'standard' | 'point';
  transfers?: BoutTransferBroadcast[];
}

function StandbyView({ 
  rings, 
  boutQueue, 
  namingMode, 
  activeAnnouncement, 
  onAnnouncementClose, 
  currentEventId, 
  boutNumberingMode = 'alphanumeric', 
  showOnlyActiveRings = false, 
  showEmptyBoutAsInactive = false, 
  isAdmin = false, 
  isAdminOnly = false,
  onUpdateInspection, 
  slideInterval = 15,
  boutTransfers = [],
  onDeleteTransfer = () => {}
}: { 
  rings: RingStatus[], 
  boutQueue: {id: string, data: MatchData}[], 
  namingMode: 'number' | 'alphabet', 
  activeAnnouncement?: { message: string, id: string } | null, 
  onAnnouncementClose?: () => void, 
  currentEventId: string | null, 
  boutNumberingMode?: 'numeric' | 'alphanumeric', 
  showOnlyActiveRings?: boolean, 
  showEmptyBoutAsInactive?: boolean, 
  isAdmin?: boolean, 
  isAdminOnly?: boolean,
  onUpdateInspection?: (ringNo: string, matchNo: string, color: 'blue' | 'red', inspected: boolean) => void, 
  slideInterval?: number,
  boutTransfers?: BoutTransferBroadcast[],
  onDeleteTransfer?: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(0);
  const [ringsPerPage, setRingsPerPage] = React.useState<number>(() => {
    const saved = localStorage.getItem('tkd_standby_rings_per_page');
    return saved ? parseInt(saved, 10) : 4;
  });
  
  const effectiveRings = showOnlyActiveRings ? rings.filter(r => r.currentBout && hasPlayers(r.currentBout)) : rings;
  const totalPages = Math.ceil(effectiveRings.length / ringsPerPage);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  React.useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) {
        setCurrentPage(0);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  React.useEffect(() => {
    let interval: NodeJS.Timeout;
    if (totalPages > 1) {
      interval = setInterval(() => {
        setCurrentPage((prev) => (prev + 1) % totalPages);
      }, slideInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [totalPages, slideInterval]);

  const displayedRings = effectiveRings.slice(currentPage * ringsPerPage, (currentPage + 1) * ringsPerPage);

  return (
    <div 
      ref={containerRef}
      className={cn(
        "bg-[#0a0e1a] min-h-full shadow-2xl border border-slate-800 transition-all duration-500 flex flex-col relative overflow-hidden",
        isFullscreen ? "rounded-none p-0" : "rounded-[2.5rem] p-6 space-y-8"
      )}
      style={{
        backgroundImage: `radial-gradient(circle at 2px 2px, rgba(255,255,255,0.03) 1px, transparent 0)`,
        backgroundSize: '4px 4px'
      }}
    >
      <PinnedTransferBanner 
        transfers={boutTransfers} 
        isAdmin={isAdminOnly} 
        onDelete={onDeleteTransfer} 
      />
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-4 bg-[#1a2235]/50 border-b border-white/10 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-900/20">
            <Trophy size={24} className="text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white uppercase tracking-tighter italic leading-none">Standby View</h2>
            <p className="text-[10px] font-black text-white uppercase tracking-[0.3em] mt-1">Live Tournament Standby Monitoring</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {totalPages > 1 && (
            <div className="flex items-center gap-2 bg-[#0d1526] border border-white/10 px-3 py-1.5 rounded-2xl">
              <button
                onClick={() => setCurrentPage(prev => (prev - 1 + totalPages) % totalPages)}
                className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                title="Previous Page"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest px-1">
                {currentPage + 1}/{totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(prev => (prev + 1) % totalPages)}
                className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                title="Next Page"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {isAdmin && (
            <div className="flex items-center gap-2 bg-[#0d1526]/80 text-white rounded-2xl border border-white/10 px-3 py-1.5">
              <span className="text-[11px] font-black uppercase text-slate-400 tracking-[0.15em] leading-none select-none">Show Layout:</span>
              <select
                value={ringsPerPage === 999 ? 'all' : ringsPerPage}
                onChange={(e) => {
                  const val = e.target.value === 'all' ? 999 : parseInt(e.target.value, 10);
                  setRingsPerPage(val);
                  localStorage.setItem('tkd_standby_rings_per_page', val.toString());
                  setCurrentPage(0);
                }}
                className="bg-transparent text-white text-xs font-black outline-none border-none focus:ring-0 cursor-pointer pr-1"
              >
                {[1, 2, 3, 4, 5, 6, 8].map(n => (
                  <option key={n} value={n} className="bg-[#1a2235] text-white font-bold">{n} Court{n > 1 ? 's' : ''}</option>
                ))}
                <option value="all" className="bg-[#1a2235] text-white font-bold">All Courts</option>
              </select>
            </div>
          )}
          <button 
            onClick={toggleFullScreen}
            className="p-3 bg-slate-900 text-white hover:bg-slate-800 rounded-2xl border border-slate-800 transition-all group"
          >
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 space-y-4">
        {displayedRings.map((ring, i) => {
          const activeTransfersForRing = (boutTransfers || []).filter(t => {
            if (!t.isPinned) return false;
            const expiry = new Date(t.pinnedUntil);
            const nowTime = new Date();
            if (expiry <= nowTime) return false;
            
            const ringNumStr = ring.ringNumber.toString().trim().toUpperCase();
            const ringNameNorm = (namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber)).trim().toUpperCase();
            const fromRingNorm = t.fromRing.trim().toUpperCase();
            const toRingNorm = t.toRing.trim().toUpperCase();
            
            return fromRingNorm === ringNumStr || fromRingNorm === ringNameNorm ||
                   toRingNorm === ringNumStr || toRingNorm === ringNameNorm;
          });

          const ringQueueAll = boutQueue
            .filter(q => 
              q.data.ring === ring.ringNumber && 
              q.data.eventId === currentEventId
            )
            .sort((a, b) => {
              const parseBout = (bout: string | number) => {
                const s = bout.toString().replace(/\s+/g, '').toUpperCase().replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
                if (/^[A-Z]/.test(s)) return s;
                return parseInt(s.replace(/[^0-9]/g, '')) || 0;
              };
              const valA = parseBout(a.data.bout);
              const valB = parseBout(b.data.bout);
              if (typeof valA === 'number' && typeof valB === 'number') return valA - valB;
              return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
            });

          const standbyRaw: typeof ringQueueAll = [];
          if (ring.onDeck) {
            standbyRaw.push({ id: `ondeck-${ring.ringNumber}`, data: ring.onDeck });
          }
          if (ring.inTheHole) {
            standbyRaw.push({ id: `inthehole-${ring.ringNumber}`, data: ring.inTheHole });
          }
          ringQueueAll.forEach(q => {
            const isAlreadyOnDeck = ring.onDeck && isBoutMatch(q.data.bout, ring.onDeck.bout);
            const isAlreadyInTheHole = ring.inTheHole && isBoutMatch(q.data.bout, ring.inTheHole.bout);
            if (!isAlreadyOnDeck && !isAlreadyInTheHole) {
              standbyRaw.push(q);
            }
          });
          const standby = standbyRaw.slice(0, 3);
          const current = ring.currentBout;
          const ringName = namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber);
          const isPoomsaeModeCurrent = current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                               current?.category?.toUpperCase().includes('FREESTYLE') ||
                               (current?.category?.toUpperCase().includes('POOMSAE') && !current.red_name);
          
          return (
            <div key={`${ring.ringNumber}-${i}`} className="flex gap-1 h-48">
              {/* Left: Current Match */}
              <div className="flex-[3] flex flex-col bg-[#0d1526] border border-white/10 rounded-lg overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-12 bg-[#1a2235] border-b border-white/10 py-2 px-4">
                  <div className="col-span-2 bg-lime-500 text-slate-950 text-[16px] font-black px-3 py-1 rounded flex items-center justify-center mr-4">
                    Ring {ringName}
                  </div>
                  <div className="col-span-10 text-white text-[18px] font-bold flex items-center">
                    {cleanPlaceholder(current?.category || "")}
                  </div>
                </div>
                {activeTransfersForRing.map(t => (
                  <div 
                    key={t.id} 
                    className="bg-yellow-500 text-slate-950 font-black text-xs uppercase px-4 py-1.5 flex items-center gap-2 animate-pulse border-b border-yellow-400 shrink-0"
                  >
                    <Bell size={12} className="shrink-0 animate-bounce" />
                    <span>BOUT TRANSFER: Court {t.fromRing} ➡️ Court {t.toRing} - Bout {t.boutNumber}</span>
                  </div>
                ))}
                {/* Content */}
                <div className="flex-1 grid grid-cols-12">
                  {(!current || !hasPlayers(current)) && showEmptyBoutAsInactive ? (
                    <div className="col-span-12 flex flex-col items-center justify-center text-slate-500/50 space-y-4 py-8">
                      <AlertCircle size={32} />
                      <p className="text-xl font-black uppercase tracking-[0.3em]">Ring Inactive</p>
                    </div>
                  ) : (
                    <>
                      {/* Bout Num */}
                      <div className="col-span-2 flex items-center justify-center text-3xl font-black text-white border-r border-white/10 bg-[#161f33]">
                        {current && hasPlayers(current) ? formatBoutNumber(ring.ringNumber, current.bout, boutNumberingMode) : "---"}
                      </div>
                      {/* Players */}
                      <div className="col-span-10 flex flex-col">
                        <div className={cn(
                          "flex-1 bg-blue-600/90 flex flex-col justify-center px-4 relative",
                          !isPoomsaeModeCurrent && "border-b border-white/10"
                        )}>
                          <p className="text-[15px] font-bold text-white uppercase leading-none mb-1">{current ? cleanPlaceholder(current.blue_club || "") : "---"}</p>
                          <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.blue_name || "") : "---"}</h4>
                        </div>
                        {!isPoomsaeModeCurrent && (
                          <div className="flex-1 bg-red-600/90 flex flex-col justify-center px-4 relative">
                            <p className="text-[15px] font-bold text-white uppercase leading-none mb-1">{current ? cleanPlaceholder(current.red_club || "") : "---"}</p>
                            <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.red_name || "") : "---"}</h4>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Middle: Ring Num */}
              <div className="flex-1 flex flex-col items-center justify-center">
                <span className="text-9xl font-black text-white italic tracking-tighter leading-none">{ringName}</span>
                <span className="text-[18px] font-black text-white uppercase tracking-[0.5em] mt-4">COURT</span>
              </div>

              {/* Right: Standby Queue */}
              <div className="flex-[2] flex flex-col gap-1">
                {[0, 1, 2].map((idx) => {
                  const b = standby[idx];
                  const isPoomsaeItem = b?.data?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                                        b?.data?.category?.toUpperCase().includes('FREESTYLE') ||
                                        (b?.data?.category?.toUpperCase().includes('POOMSAE') && !b?.data?.red_name);
                  const isRingInactive = showEmptyBoutAsInactive && (!current || !hasPlayers(current));
                  return (
                    <div key={idx} className="flex-1 grid grid-cols-12 bg-[#0d1526] border border-white/10 rounded overflow-hidden">
                      <div className="col-span-3 flex items-center justify-center text-xl font-black text-white bg-[#161f33] border-r border-white/10">
                        {b?.data?.bout ? formatBoutNumber(ring.ringNumber, b.data.bout, boutNumberingMode) : "---"}
                      </div>
                      <div className={cn(
                        "flex flex-col justify-center px-3 relative",
                        isPoomsaeItem ? "col-span-9" : "col-span-5 border-r border-white/10",
                        isRingInactive ? "bg-slate-800" : "bg-blue-600/80"
                      )}>
                        <span className="text-[13px] font-bold text-white uppercase leading-tight break-words whitespace-normal w-full">{cleanPlaceholder(b?.data.blue_club || "")}</span>
                        <span className={cn(
                          "text-[16px] font-black uppercase leading-tight break-words whitespace-normal w-full mt-0.5",
                          isRingInactive ? "text-slate-400" : "text-white"
                        )}>{cleanPlaceholder(b?.data.blue_name || "")}</span>
                        {b?.data.blue_inspected ? (
                          <div className="absolute bottom-1 right-2 z-10">
                            <span 
                              onClick={isAdmin && onUpdateInspection ? () => onUpdateInspection(ring.ringNumber.toString(), b!.data.bout.toString(), 'blue', false) : undefined}
                              className={cn(
                                "text-[10px] font-black uppercase tracking-tighter",
                                isRingInactive ? "text-slate-600" : "text-green-400",
                                isAdmin && onUpdateInspection ? "cursor-pointer hover:opacity-80 transition-opacity" : ""
                              )}>INSPECTED</span>
                          </div>
                        ) : (
                          isAdmin && hasPlayers(b?.data) && onUpdateInspection && (
                            <div className="absolute bottom-1 right-2 z-10">
                              <button 
                                onClick={() => onUpdateInspection(ring.ringNumber.toString(), b!.data.bout.toString(), 'blue', true)}
                                className={cn(
                                  "text-[10px] font-black uppercase tracking-tighter underline hover:text-white transition-colors",
                                  isRingInactive ? "text-slate-600" : "text-white/60"
                                )}>
                                UNINSPECTED
                              </button>
                            </div>
                          )
                        )}
                      </div>
                      {!isPoomsaeItem && (
                        <div className={cn(
                          "col-span-4 flex flex-col justify-center px-3 relative",
                          isRingInactive ? "bg-slate-800" : "bg-red-600/80"
                        )}>
                          <span className="text-[13px] font-bold text-white uppercase leading-tight break-words whitespace-normal w-full">{cleanPlaceholder(b?.data.red_club || "")}</span>
                          <span className={cn(
                            "text-[16px] font-black uppercase leading-tight break-words whitespace-normal w-full mt-0.5",
                            isRingInactive ? "text-slate-400" : "text-white"
                          )}>{cleanPlaceholder(b?.data.red_name || "")}</span>
                          {b?.data.red_inspected ? (
                            <div className="absolute bottom-1 right-2 z-10">
                              <span 
                                onClick={isAdmin && onUpdateInspection ? () => onUpdateInspection(ring.ringNumber.toString(), b!.data.bout.toString(), 'red', false) : undefined}
                                className={cn(
                                  "text-[10px] font-black uppercase tracking-tighter",
                                  isRingInactive ? "text-slate-600" : "text-green-400",
                                  isAdmin && onUpdateInspection ? "cursor-pointer hover:opacity-80 transition-opacity" : ""
                                )}>INSPECTED</span>
                            </div>
                          ) : (
                            isAdmin && hasPlayers(b?.data) && onUpdateInspection && (
                              <div className="absolute bottom-1 right-2 z-10">
                                <button 
                                  onClick={() => onUpdateInspection(ring.ringNumber.toString(), b!.data.bout.toString(), 'red', true)}
                                  className={cn(
                                    "text-[10px] font-black uppercase tracking-tighter underline hover:text-white transition-colors",
                                    isRingInactive ? "text-slate-600" : "text-white/60"
                                  )}>
                                  UNINSPECTED
                                </button>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <AnnouncementPopup announcement={activeAnnouncement || null} onClose={onAnnouncementClose || (() => {})} size={isFullscreen ? 'large' : 'normal'} />
    </div>
  );
}

function SiteView({ 
  rings, 
  boutQueue, 
  namingMode, 
  activeAnnouncement, 
  onAnnouncementClose, 
  currentEventId, 
  boutNumberingMode = 'alphanumeric', 
  showOnlyActiveRings = false, 
  showEmptyBoutAsInactive = false, 
  isAdmin = false, 
  isAdminOnly = false,
  onUpdateInspection, 
  slideInterval = 15,
  boutTransfers = [],
  onDeleteTransfer = () => {}
}: { 
  rings: RingStatus[], 
  boutQueue: {id: string, data: MatchData}[], 
  namingMode: 'number' | 'alphabet', 
  activeAnnouncement?: { message: string, id: string } | null, 
  onAnnouncementClose?: () => void, 
  currentEventId: string | null, 
  boutNumberingMode?: 'numeric' | 'alphanumeric', 
  showOnlyActiveRings?: boolean, 
  showEmptyBoutAsInactive?: boolean, 
  isAdmin?: boolean, 
  isAdminOnly?: boolean,
  onUpdateInspection?: (ringNo: string, matchNo: string, color: 'blue' | 'red', inspected: boolean) => void, 
  slideInterval?: number,
  boutTransfers?: BoutTransferBroadcast[],
  onDeleteTransfer?: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(0);
  const [ringsPerPage, setRingsPerPage] = React.useState<number>(() => {
    const saved = localStorage.getItem('tkd_site_rings_per_page');
    return saved ? parseInt(saved, 10) : 4;
  });
  
  const effectiveRings = showOnlyActiveRings ? rings.filter(r => r.currentBout && hasPlayers(r.currentBout)) : rings;
  const totalPages = Math.ceil(effectiveRings.length / ringsPerPage);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  React.useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) {
        setCurrentPage(0);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  React.useEffect(() => {
    let interval: NodeJS.Timeout;
    if (totalPages > 1) {
      interval = setInterval(() => {
        setCurrentPage((prev) => (prev + 1) % totalPages);
      }, slideInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [totalPages, slideInterval]);

  const displayedRings = effectiveRings.slice(currentPage * ringsPerPage, (currentPage + 1) * ringsPerPage);

  return (
    <div 
      ref={containerRef}
      className={cn(
        "bg-[#0a0e1a] min-h-full shadow-2xl border border-slate-800 transition-all duration-500 flex flex-col relative overflow-hidden",
        isFullscreen ? "rounded-none p-0" : "rounded-[2.5rem] p-6 space-y-8"
      )}
      style={{
        backgroundImage: `radial-gradient(circle at 2px 2px, rgba(255,255,255,0.03) 1px, transparent 0)`,
        backgroundSize: '4px 4px'
      }}
    >
      <PinnedTransferBanner 
        transfers={boutTransfers} 
        isAdmin={isAdminOnly} 
        onDelete={onDeleteTransfer} 
      />
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-4 bg-[#1a2235]/50 border-b border-white/10 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-900/20">
            <Trophy size={24} className="text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white uppercase tracking-tighter italic leading-none">Site VIew</h2>
            <p className="text-[10px] font-black text-white uppercase tracking-[0.3em] mt-1">Live Tournament Site Monitoring</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {totalPages > 1 && (
            <div className="flex items-center gap-2 bg-[#0d1526] border border-white/10 px-3 py-1.5 rounded-2xl">
              <button
                onClick={() => setCurrentPage(prev => (prev - 1 + totalPages) % totalPages)}
                className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                title="Previous Page"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest px-1">
                {currentPage + 1}/{totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(prev => (prev + 1) % totalPages)}
                className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                title="Next Page"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {isAdmin && (
            <div className="flex items-center gap-2 bg-[#0d1526]/80 text-white rounded-2xl border border-white/10 px-3 py-1.5">
              <span className="text-[11px] font-black uppercase text-slate-400 tracking-[0.15em] leading-none select-none">Show Layout:</span>
              <select
                value={ringsPerPage === 999 ? 'all' : ringsPerPage}
                onChange={(e) => {
                  const val = e.target.value === 'all' ? 999 : parseInt(e.target.value, 10);
                  setRingsPerPage(val);
                  localStorage.setItem('tkd_site_rings_per_page', val.toString());
                  setCurrentPage(0);
                }}
                className="bg-transparent text-white text-xs font-black outline-none border-none focus:ring-0 cursor-pointer pr-1"
              >
                {[1, 2, 3, 4, 5, 6, 8].map(n => (
                  <option key={n} value={n} className="bg-[#1a2235] text-white font-bold">{n} Court{n > 1 ? 's' : ''}</option>
                ))}
                <option value="all" className="bg-[#1a2235] text-white font-bold">All Courts</option>
              </select>
            </div>
          )}
          <button 
            onClick={toggleFullScreen}
            className="p-3 bg-slate-900 text-white hover:bg-slate-800 rounded-2xl border border-slate-800 transition-all group"
          >
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 space-y-4">
        {displayedRings.map((ring, i) => {
          const ringQueueAll = boutQueue
            .filter(q => 
              q.data.ring === ring.ringNumber && 
              q.data.eventId === currentEventId
            )
            .sort((a, b) => {
              const parseBout = (bout: string | number) => {
                const s = bout.toString().replace(/\s+/g, '').toUpperCase().replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
                if (/^[A-Z]/.test(s)) return s;
                return parseInt(s.replace(/[^0-9]/g, '')) || 0;
              };
              const valA = parseBout(a.data.bout);
              const valB = parseBout(b.data.bout);
              if (typeof valA === 'number' && typeof valB === 'number') return valA - valB;
              return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
            });

          const standbyRaw: typeof ringQueueAll = [];
          if (ring.onDeck) {
            standbyRaw.push({ id: `ondeck-${ring.ringNumber}`, data: ring.onDeck });
          }
          if (ring.inTheHole) {
            standbyRaw.push({ id: `inthehole-${ring.ringNumber}`, data: ring.inTheHole });
          }
          ringQueueAll.forEach(q => {
            const isAlreadyOnDeck = ring.onDeck && isBoutMatch(q.data.bout, ring.onDeck.bout);
            const isAlreadyInTheHole = ring.inTheHole && isBoutMatch(q.data.bout, ring.inTheHole.bout);
            if (!isAlreadyOnDeck && !isAlreadyInTheHole) {
              standbyRaw.push(q);
            }
          });
          const standby = standbyRaw.slice(0, 3);
          const current = ring.currentBout;
          const ringName = namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber);
          const isPoomsaeModeCurrent = current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                               current?.category?.toUpperCase().includes('FREESTYLE') ||
                               (current?.category?.toUpperCase().includes('POOMSAE') && !current.red_name);
          
          return (
            <div key={`${ring.ringNumber}-${i}`} className="flex gap-1 h-48">
              {/* Left: Current Match */}
              <div className="flex-[3] flex flex-col bg-[#0d1526] border border-white/10 rounded-lg overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-12 bg-[#1a2235] border-b border-white/10 py-2 px-4">
                  <div className="col-span-2 bg-lime-500 text-slate-950 text-[16px] font-black px-3 py-1 rounded flex items-center justify-center mr-4">
                    Ring {ringName}
                  </div>
                  <div className="col-span-10 text-white text-[18px] font-bold flex items-center">
                    {cleanPlaceholder(current?.category || "")}
                  </div>
                </div>
                {/* Content */}
                <div className="flex-1 grid grid-cols-12">
                  {(!current || !hasPlayers(current)) && showEmptyBoutAsInactive ? (
                    <div className="col-span-12 flex flex-col items-center justify-center text-slate-500/50 space-y-4 py-8">
                      <AlertCircle size={32} />
                      <p className="text-xl font-black uppercase tracking-[0.3em]">Ring Inactive</p>
                    </div>
                  ) : (
                    <>
                      {/* Bout Num */}
                      <div className="col-span-2 flex items-center justify-center text-3xl font-black text-white border-r border-[#1a1f2e] bg-[#161f33]">
                        {current && hasPlayers(current) ? formatBoutNumber(ring.ringNumber, current.bout, boutNumberingMode) : "---"}
                      </div>
                      {/* Players */}
                      <div className="col-span-10 flex flex-col">
                        <div className={cn(
                          "flex-1 bg-blue-600/90 flex flex-col justify-center px-4 relative",
                          !isPoomsaeModeCurrent && "border-b border-white/10"
                        )}>
                          <p className="text-[15px] font-bold text-white uppercase leading-none mb-1">{current ? cleanPlaceholder(current.blue_club || "") : "---"}</p>
                          <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.blue_name || "") : "---"}</h4>
                        </div>
                        {!isPoomsaeModeCurrent && (
                          <div className="flex-1 bg-red-600/90 flex flex-col justify-center px-4 relative">
                            <p className="text-[15px] font-bold text-white uppercase leading-none mb-1">{current ? cleanPlaceholder(current.red_club || "") : "---"}</p>
                            <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.red_name || "") : "---"}</h4>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Middle: Ring Num */}
              <div className="flex-1 flex flex-col items-center justify-center">
                <span className="text-9xl font-black text-white italic tracking-tighter leading-none">{ringName}</span>
                <span className="text-[18px] font-black text-white uppercase tracking-[0.5em] mt-4">COURT</span>
              </div>

              {/* Right: Standby Queue */}
              <div className="flex-[2] flex flex-col gap-1">
                {[0, 1, 2].map((idx) => {
                  const b = standby[idx];
                  const isPoomsaeItem = b?.data?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                                        b?.data?.category?.toUpperCase().includes('FREESTYLE') ||
                                        (b?.data?.category?.toUpperCase().includes('POOMSAE') && !b?.data?.red_name);
                  const isRingInactive = showEmptyBoutAsInactive && (!current || !hasPlayers(current));
                  return (
                    <div key={idx} className="flex-1 grid grid-cols-12 bg-[#0d1526] border border-white/10 rounded overflow-hidden">
                      <div className="col-span-3 flex items-center justify-center text-xl font-black text-white bg-[#161f33] border-r border-[#1a1f2e]">
                        {b?.data?.bout ? formatBoutNumber(ring.ringNumber, b.data.bout, boutNumberingMode) : "---"}
                      </div>
                      <div className={cn(
                        "flex flex-col justify-center px-3 relative",
                        isPoomsaeItem ? "col-span-9" : "col-span-5 border-r border-white/10",
                        isRingInactive ? "bg-slate-800" : "bg-blue-600/80"
                      )}>
                        <span className="text-[13px] font-bold text-white uppercase leading-tight break-words whitespace-normal w-full">{cleanPlaceholder(b?.data.blue_club || "")}</span>
                        <span className={cn(
                          "text-[16px] font-black uppercase leading-tight break-words whitespace-normal w-full mt-0.5",
                          isRingInactive ? "text-slate-400" : "text-white"
                        )}>{cleanPlaceholder(b?.data.blue_name || "")}</span>
                      </div>
                      {!isPoomsaeItem && (
                        <div className={cn(
                          "col-span-4 flex flex-col justify-center px-3 relative",
                          isRingInactive ? "bg-slate-800" : "bg-red-600/80"
                        )}>
                          <span className="text-[13px] font-bold text-white uppercase leading-tight break-words whitespace-normal w-full">{cleanPlaceholder(b?.data.red_club || "")}</span>
                          <span className={cn(
                            "text-[16px] font-black uppercase leading-tight break-words whitespace-normal w-full mt-0.5",
                            isRingInactive ? "text-slate-400" : "text-white"
                          )}>{cleanPlaceholder(b?.data.red_name || "")}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <AnnouncementPopup announcement={activeAnnouncement || null} onClose={onAnnouncementClose || (() => {})} size={isFullscreen ? 'large' : 'normal'} />
    </div>
  );
}

function PointsView({ 
  rings, 
  boutQueue, 
  namingMode, 
  activeAnnouncement, 
  onAnnouncementClose, 
  currentEventId, 
  boutNumberingMode = 'alphanumeric', 
  showOnlyActiveRings = false, 
  showEmptyBoutAsInactive = false, 
  isAdmin = false, 
  isAdminOnly = false,
  slideInterval = 15,
  boutTransfers = [],
  onDeleteTransfer = () => {}
}: { 
  rings: RingStatus[], 
  boutQueue: {id: string, data: MatchData}[], 
  namingMode: 'number' | 'alphabet', 
  activeAnnouncement?: { message: string, id: string } | null, 
  onAnnouncementClose?: () => void, 
  currentEventId: string | null, 
  boutNumberingMode?: 'numeric' | 'alphanumeric', 
  showOnlyActiveRings?: boolean, 
  showEmptyBoutAsInactive?: boolean, 
  isAdmin?: boolean, 
  isAdminOnly?: boolean,
  slideInterval?: number,
  boutTransfers?: BoutTransferBroadcast[],
  onDeleteTransfer?: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(0);
  const [ringsPerPage, setRingsPerPage] = React.useState<number>(() => {
    const saved = localStorage.getItem('tkd_points_rings_per_page');
    return saved ? parseInt(saved, 10) : 4;
  });
  
  const effectiveRings = showOnlyActiveRings ? rings.filter(r => r.currentBout && hasPlayers(r.currentBout)) : rings;
  const totalPages = Math.ceil(effectiveRings.length / ringsPerPage);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  React.useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) {
        setCurrentPage(0);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  React.useEffect(() => {
    let interval: NodeJS.Timeout;
    if (totalPages > 1) {
      interval = setInterval(() => {
        setCurrentPage((prev) => (prev + 1) % totalPages);
      }, slideInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [totalPages, slideInterval]);

  const displayedRings = effectiveRings.slice(currentPage * ringsPerPage, (currentPage + 1) * ringsPerPage);

  return (
    <div 
      ref={containerRef}
      className={cn(
        "bg-[#0a0e1a] min-h-full shadow-2xl border border-slate-800 transition-all duration-500 flex flex-col relative overflow-hidden",
        isFullscreen ? "rounded-none p-0" : "rounded-[2.5rem] p-6 space-y-8"
      )}
      style={{
        backgroundImage: `radial-gradient(circle at 2px 2px, rgba(255,255,255,0.03) 1px, transparent 0)`,
        backgroundSize: '4px 4px'
      }}
    >
      <PinnedTransferBanner 
        transfers={boutTransfers} 
        isAdmin={isAdminOnly} 
        onDelete={onDeleteTransfer} 
      />
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-4 bg-[#1a2235]/50 border-b border-white/10 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-900/20">
            <Trophy size={24} className="text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-white uppercase tracking-tighter italic leading-none">LIVE VIEW</h2>
            <p className="text-[10px] font-black text-white uppercase tracking-[0.3em] mt-1">Live Tournament Points Monitoring</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {totalPages > 1 && (
            <div className="flex items-center gap-2 bg-[#0d1526] border border-white/10 px-3 py-1.5 rounded-2xl">
              <button
                onClick={() => setCurrentPage(prev => (prev - 1 + totalPages) % totalPages)}
                className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                title="Previous Page"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest px-1">
                {currentPage + 1}/{totalPages}
              </span>
              <button
                onClick={() => setCurrentPage(prev => (prev + 1) % totalPages)}
                className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                title="Next Page"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {isAdmin && (
            <div className="flex items-center gap-2 bg-[#0d1526]/80 text-white rounded-2xl border border-white/10 px-3 py-1.5">
              <span className="text-[11px] font-black uppercase text-slate-400 tracking-[0.15em] leading-none select-none">Show Layout:</span>
              <select
                value={ringsPerPage === 999 ? 'all' : ringsPerPage}
                onChange={(e) => {
                  const val = e.target.value === 'all' ? 999 : parseInt(e.target.value, 10);
                  setRingsPerPage(val);
                  localStorage.setItem('tkd_points_rings_per_page', val.toString());
                  setCurrentPage(0);
                }}
                className="bg-transparent text-white text-xs font-black outline-none border-none focus:ring-0 cursor-pointer pr-1"
              >
                {[1, 2, 3, 4, 5, 6, 8].map(n => (
                  <option key={n} value={n} className="bg-[#1a2235] text-white font-bold">{n} Ring{n > 1 ? 's' : ''}</option>
                ))}
                <option value="all" className="bg-[#1a2235] text-white font-bold">All Rings</option>
              </select>
            </div>
          )}
          <button 
            onClick={toggleFullScreen}
            className="p-3 bg-slate-900 text-white hover:bg-slate-800 rounded-2xl border border-slate-800 transition-all group"
          >
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </div>
      </div>

      <div className="flex-1 p-4 space-y-4">
        {displayedRings.map((ring, i) => {
          const ringQueue = boutQueue
            .filter(q => 
              q.data.ring === ring.ringNumber && 
              q.data.eventId === currentEventId
            )
            .sort((a, b) => {
              const parseBout = (bout: string | number) => {
                const s = bout.toString().replace(/\s+/g, '').toUpperCase().replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
                if (/^[A-Z]/.test(s)) return s;
                return parseInt(s.replace(/[^0-9]/g, '')) || 0;
              };
              const valA = parseBout(a.data.bout);
              const valB = parseBout(b.data.bout);
              if (typeof valA === 'number' && typeof valB === 'number') return valA - valB;
              return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
            })
            .slice(0, 3);
          const current = ring.currentBout;
          const standby = ringQueue;
          const ringName = namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber);
          const isPoomsaeModeCurrent = current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                               current?.category?.toUpperCase().includes('FREESTYLE') ||
                               (current?.category?.toUpperCase().includes('POOMSAE') && !current.red_name);
          
          return (
            <div key={`${ring.ringNumber}-${i}`} className="flex gap-1 h-48">
              {/* Left: Current Match */}
              <div className="flex-[4] flex flex-col bg-[#0d1526] border border-white/10 rounded-lg overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-12 bg-[#1a2235] border-b border-white/10 py-2 px-4">
                  <div className="col-span-2 bg-lime-500 text-slate-950 text-[16px] font-black px-3 py-1 rounded flex items-center justify-center mr-4">
                    Ring {ringName}
                  </div>
                  <div className="col-span-10 text-white text-[18px] font-bold flex items-center">
                    {cleanPlaceholder(current?.category || "")}
                  </div>
                </div>
                {/* Content */}
                <div className="flex-1 grid grid-cols-12">
                  {(!current || !hasPlayers(current)) && showEmptyBoutAsInactive ? (
                    <div className="col-span-12 flex flex-col items-center justify-center text-slate-500/50 space-y-4 py-8">
                      <AlertCircle size={32} />
                      <p className="text-xl font-black uppercase tracking-[0.3em]">Ring Inactive</p>
                    </div>
                  ) : (
                    <>
                      {/* Bout Num */}
                      <div className="col-span-2 flex items-center justify-center text-3xl font-black text-white border-r border-white/10 bg-[#161f33]">
                        {current && hasPlayers(current) ? formatBoutNumber(ring.ringNumber, current.bout, boutNumberingMode) : "---"}
                      </div>
                      {/* Players & Points */}
                      <div className="col-span-10 grid grid-cols-12 h-full">
                        <div className={isPoomsaeModeCurrent ? "col-span-12 flex flex-col" : "col-span-6 flex flex-col"}>
                          <div className={cn(
                            "flex-1 bg-blue-600/90 flex flex-col justify-center px-4 relative",
                            !isPoomsaeModeCurrent && "border-b border-white/10"
                          )}>
                            <p className="text-[15px] font-bold text-white uppercase leading-none mb-1">{current ? cleanPlaceholder(current.blue_club || "") : "---"}</p>
                            <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.blue_name || "") : "---"}</h4>
                          </div>
                          {!isPoomsaeModeCurrent && (
                            <div className="flex-1 bg-red-600/90 flex flex-col justify-center px-4 relative">
                              <p className="text-[15px] font-bold text-white uppercase leading-none mb-1">{current ? cleanPlaceholder(current.red_club || "") : "---"}</p>
                              <h4 className="text-[30px] font-black text-white uppercase leading-none truncate">{current ? cleanPlaceholder(current.red_name || "") : "---"}</h4>
                            </div>
                          )}
                        </div>
                        {!isPoomsaeModeCurrent && (() => {
                          const getRoundWinnerSpec = (roundNum: number) => {
                            const pt = current?.points;
                            if (!pt) return '';
                            const winKey = `r${roundNum}Winner`;
                            const explicitVal = pt[winKey as 'r1Winner' | 'r2Winner' | 'r3Winner'];
                            if (explicitVal === 'Blue' || explicitVal === 'Red') return explicitVal;
                            
                            const blueVal = pt[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'] !== undefined && pt[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'] !== null ? parseInt(pt[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'] || '') : NaN;
                            const redVal = pt[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'] !== undefined && pt[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'] !== null ? parseInt(pt[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'] || '') : NaN;
                            if (!isNaN(blueVal) && !isNaN(redVal)) {
                              if (blueVal > redVal) return 'Blue';
                              if (redVal > blueVal) return 'Red';
                            }
                            return '';
                          };
                          const r1Win = getRoundWinnerSpec(1);
                          const r2Win = getRoundWinnerSpec(2);
                          const r3Win = getRoundWinnerSpec(3);

                          return (
                            <div className="col-span-6 flex flex-col border-l border-white/10 bg-[#0d1526]">
                              {/* Point columns */}
                              <div className="flex-1 flex flex-col border-b border-white/10">
                                <div className="flex-1 grid grid-cols-3 divide-x divide-white/10">
                                  <div className="flex items-center justify-center">
                                    <span className={cn(
                                      "w-12 h-12 flex items-center justify-center font-black text-3xl transition-all",
                                      r1Win === 'Blue' 
                                        ? "text-[#00a2e8] rounded-full border-4 border-[#00a2e8] bg-[#00a2e8]/15 shadow-[0_0_12px_rgba(0,162,232,0.5)] scale-105" 
                                        : "text-white"
                                    )}>
                                      {current?.points?.r1Blue || '-'}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-center">
                                    <span className={cn(
                                      "w-12 h-12 flex items-center justify-center font-black text-3xl transition-all",
                                      r2Win === 'Blue' 
                                        ? "text-[#00a2e8] rounded-full border-4 border-[#00a2e8] bg-[#00a2e8]/15 shadow-[0_0_12px_rgba(0,162,232,0.5)] scale-105" 
                                        : "text-white"
                                    )}>
                                      {current?.points?.r2Blue || '-'}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-center">
                                    <span className={cn(
                                      "w-12 h-12 flex items-center justify-center font-black text-3xl transition-all",
                                      r3Win === 'Blue' 
                                        ? "text-[#00a2e8] rounded-full border-4 border-[#00a2e8] bg-[#00a2e8]/15 shadow-[0_0_12px_rgba(0,162,232,0.5)] scale-105" 
                                        : "text-white"
                                    )}>
                                      {current?.points?.r3Blue || '-'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              {!isPoomsaeModeCurrent && (
                                <div className="flex-1 flex flex-col">
                                  <div className="flex-1 grid grid-cols-3 divide-x divide-white/10">
                                    <div className="flex items-center justify-center">
                                      <span className={cn(
                                        "w-12 h-12 flex items-center justify-center font-black text-3xl transition-all",
                                        r1Win === 'Red' 
                                          ? "text-[#ed1c24] rounded-full border-4 border-[#ed1c24] bg-[#ed1c24]/15 shadow-[0_0_12px_rgba(237,28,36,0.5)] scale-105" 
                                          : "text-white"
                                      )}>
                                        {current?.points?.r1Red || '-'}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-center">
                                      <span className={cn(
                                        "w-12 h-12 flex items-center justify-center font-black text-3xl transition-all",
                                        r2Win === 'Red' 
                                          ? "text-[#ed1c24] rounded-full border-4 border-[#ed1c24] bg-[#ed1c24]/15 shadow-[0_0_12px_rgba(237,28,36,0.5)] scale-105" 
                                          : "text-white"
                                      )}>
                                        {current?.points?.r2Red || '-'}
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-center">
                                      <span className={cn(
                                        "w-12 h-12 flex items-center justify-center font-black text-3xl transition-all",
                                        r3Win === 'Red' 
                                          ? "text-[#ed1c24] rounded-full border-4 border-[#ed1c24] bg-[#ed1c24]/15 shadow-[0_0_12px_rgba(237,28,36,0.5)] scale-105" 
                                          : "text-white"
                                      )}>
                                        {current?.points?.r3Red || '-'}
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Middle: Ring Num */}
              <div className="flex-[0.5] flex flex-col items-center justify-center">
                <span className="text-6xl font-black text-white italic tracking-tighter leading-none">{ringName}</span>
                <span className="text-[12px] font-black text-white uppercase tracking-[0.5em] mt-2">COURT</span>
              </div>

              {/* Right: Standby Queue */}
              <div className="flex-[1.5] flex flex-col gap-1">
                {[0, 1, 2].map((idx) => {
                  const b = standby[idx];
                  const isPoomsaeItem = b?.data?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                                        b?.data?.category?.toUpperCase().includes('FREESTYLE') ||
                                        (b?.data?.category?.toUpperCase().includes('POOMSAE') && !b?.data?.red_name);
                  const isRingInactive = showEmptyBoutAsInactive && (!current || !hasPlayers(current));
                  return (
                    <div key={idx} className="flex-1 grid grid-cols-12 bg-[#0d1526] border border-white/10 rounded overflow-hidden">
                      <div className="col-span-3 flex items-center justify-center text-xl font-black text-white bg-[#161f33] border-r border-white/10">
                        {b?.data?.bout ? formatBoutNumber(ring.ringNumber, b.data.bout, boutNumberingMode) : "---"}
                      </div>
                      <div className={cn(
                        "flex flex-col justify-center px-3 relative",
                        isPoomsaeItem ? "col-span-9" : "col-span-5 border-r border-white/10",
                        isRingInactive ? "bg-slate-800" : "bg-blue-600/80"
                      )}>
                        <span className="text-[13px] font-bold text-white uppercase leading-none">{cleanPlaceholder(b?.data.blue_club || "")}</span>
                        <span className={cn(
                          "text-[16px] font-black uppercase truncate leading-tight",
                          isRingInactive ? "text-slate-400" : "text-white"
                        )}>{cleanPlaceholder(b?.data.blue_name || "")}</span>
                        
                      </div>
                      {!isPoomsaeItem && (
                        <div className={cn(
                          "col-span-4 flex flex-col justify-center px-3 relative",
                          isRingInactive ? "bg-slate-800" : "bg-red-600/80"
                        )}>
                          <span className="text-[13px] font-bold text-white uppercase leading-none">{cleanPlaceholder(b?.data.red_club || "")}</span>
                          <span className={cn(
                            "text-[16px] font-black uppercase truncate leading-tight",
                            isRingInactive ? "text-slate-400" : "text-white"
                          )}>{cleanPlaceholder(b?.data.red_name || "")}</span>
                          
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <AnnouncementPopup announcement={activeAnnouncement || null} onClose={onAnnouncementClose || (() => {})} size={isFullscreen ? 'large' : 'normal'} />
    </div>
  );
}



function OnsiteView({ 
  rings, 
  boutQueue, 
  namingMode, 
  activeAnnouncement, 
  onAnnouncementClose, 
  currentEventId, 
  boutNumberingMode = 'alphanumeric', 
  showOnlyActiveRings = false, 
  showEmptyBoutAsInactive = false, 
  isAdmin = false, 
  isAdminOnly = false,
  slideInterval = 15,
  boutTransfers = [],
  onDeleteTransfer = () => {}
}: { 
  rings: RingStatus[], 
  boutQueue: {id: string, data: MatchData}[], 
  namingMode: 'number' | 'alphabet', 
  activeAnnouncement?: { message: string, id: string } | null, 
  onAnnouncementClose?: () => void, 
  currentEventId: string | null, 
  boutNumberingMode?: 'numeric' | 'alphanumeric', 
  showOnlyActiveRings?: boolean, 
  showEmptyBoutAsInactive?: boolean, 
  isAdmin?: boolean, 
  isAdminOnly?: boolean,
  slideInterval?: number,
  boutTransfers?: BoutTransferBroadcast[],
  onDeleteTransfer?: (id: string) => void
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(0);
  const [ringsPerPage, setRingsPerPage] = React.useState<number>(() => {
    const saved = localStorage.getItem('tkd_onsite_rings_per_page');
    return saved ? parseInt(saved, 10) : 3;
  });

  const effectiveRings = showOnlyActiveRings ? rings.filter(r => r.currentBout && hasPlayers(r.currentBout)) : rings;
  const totalPages = Math.ceil(effectiveRings.length / ringsPerPage);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  React.useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) {
        setCurrentPage(0);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Auto-scroll logic for fullscreen mode
  React.useEffect(() => {
    let interval: NodeJS.Timeout;
    if (totalPages > 1) {
      interval = setInterval(() => {
        setCurrentPage((prev) => (prev + 1) % totalPages);
      }, slideInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [totalPages, slideInterval]);

  const displayedRings = effectiveRings.slice(currentPage * ringsPerPage, (currentPage + 1) * ringsPerPage);

  const getDynamicFontSize = (name: string) => {
    const len = name.length;
    if (len <= 15) return isFullscreen ? 'text-[52px] tracking-[2px]' : 'text-[34px] tracking-[1px]';
    if (len <= 25) return isFullscreen ? 'text-[38px] tracking-[1px]' : 'text-[26px] tracking-normal';
    if (len <= 35) return isFullscreen ? 'text-[28px] tracking-tight' : 'text-[20px] tracking-tight';
    if (len <= 45) return isFullscreen ? 'text-[22px] tracking-tighter' : 'text-[16px] tracking-tighter';
    return isFullscreen ? 'text-[18px] tracking-tighter' : 'text-[12px] tracking-tighter';
  };

  const getStandbyDynamicFontSize = (name: string) => {
    const len = name.length;
    if (len <= 15) return 'text-[15px]';
    if (len <= 25) return 'text-[13px]';
    if (len <= 35) return 'text-[11px]';
    return 'text-[9px]';
  };

  return (
    <div 
      ref={containerRef}
      className={cn(
        "bg-slate-950 min-h-full shadow-2xl border border-slate-800 transition-all duration-500 flex flex-col relative",
        isFullscreen ? "rounded-none px-12 py-6 overflow-hidden" : "rounded-[2.5rem] p-6 space-y-8"
      )}
    >
      <PinnedTransferBanner 
        transfers={boutTransfers} 
        isAdmin={isAdminOnly} 
        onDelete={onDeleteTransfer} 
      />
      {!isFullscreen && (
        <div className="flex items-center justify-between px-4 flex-shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-900/20">
              <Trophy size={24} className="text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-black text-white uppercase tracking-tighter italic leading-none">Onsite Tournament Overview</h2>
              <p className="text-[10px] font-black text-white uppercase tracking-[0.3em] mt-1">Live Multi-Court Monitoring System</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            {totalPages > 1 && (
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-2xl">
                <button
                  onClick={() => setCurrentPage(prev => (prev - 1 + totalPages) % totalPages)}
                  className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                  title="Previous Page"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest px-1">
                  {currentPage + 1}/{totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(prev => (prev + 1) % totalPages)}
                  className="p-1 hover:bg-slate-800 text-white rounded transition-colors"
                  title="Next Page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            {isAdmin && (
              <div className="flex items-center gap-2 bg-slate-900 text-white rounded-2xl border border-slate-850 px-3 py-1.5">
                <span className="text-[11px] font-black uppercase text-slate-400 tracking-[0.15em] leading-none select-none">Show Layout:</span>
                <select
                  value={ringsPerPage === 999 ? 'all' : ringsPerPage}
                  onChange={(e) => {
                    const val = e.target.value === 'all' ? 999 : parseInt(e.target.value, 10);
                    setRingsPerPage(val);
                    localStorage.setItem('tkd_onsite_rings_per_page', val.toString());
                    setCurrentPage(0);
                  }}
                  className="bg-transparent text-white text-xs font-black outline-none border-none focus:ring-0 cursor-pointer pr-1"
                >
                  {[1, 2, 3, 4, 5, 6, 8].map(n => (
                    <option key={n} value={n} className="bg-slate-900 text-white font-bold">{n} Court{n > 1 ? 's' : ''}</option>
                  ))}
                  <option value="all" className="bg-slate-900 text-white font-bold">All Courts</option>
                </select>
              </div>
            )}
            <div className="flex flex-col items-end">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs font-black text-green-500 uppercase tracking-widest">System Live</span>
              </div>
              <p className="text-[9px] font-bold text-white uppercase tracking-widest mt-1">Real-time Data Sync</p>
            </div>
            <button 
              onClick={toggleFullScreen}
              className="p-3 bg-slate-900 text-white hover:text-white hover:bg-slate-800 rounded-2xl border border-slate-800 transition-all group"
              title="Enter Fullscreen"
            >
              <Maximize size={20} className="group-hover:scale-110 transition-transform" />
            </button>
          </div>
        </div>
      )}

      {isFullscreen && (
        <>
          <div className="absolute top-6 left-12 flex items-center gap-4 z-50">
            <div className="w-12 h-12 bg-red-600 rounded-2xl flex items-center justify-center shadow-lg shadow-red-900/20">
              <Trophy size={24} className="text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-black text-white uppercase tracking-tighter italic leading-none">Onsite Tournament Overview</h2>
              <p className="text-[10px] font-black text-white uppercase tracking-[0.3em] mt-1">Live Multi-Court Monitoring System</p>
            </div>
          </div>
          <button 
            onClick={toggleFullScreen}
            className="absolute top-6 right-6 p-3 bg-slate-900/50 hover:bg-slate-800 text-slate-400 hover:text-white rounded-2xl border border-slate-800 transition-all z-50 opacity-0 hover:opacity-100"
            title="Exit Fullscreen"
          >
            <Minimize size={20} />
          </button>
        </>
      )}

      <div className={cn(
        "flex-1 overflow-y-auto custom-scrollbar px-4",
        isFullscreen ? "flex flex-col justify-around pt-24 pb-4 gap-y-8" : "space-y-24 py-12"
      )}>
        {displayedRings.map((ring, i) => {
          const ringQueueAll = boutQueue
            .filter(q => 
              q.data.ring === ring.ringNumber && 
              q.data.eventId === currentEventId
            )
            .sort((a, b) => {
              const parseBout = (bout: string | number) => {
                const s = bout.toString().replace(/\s+/g, '').toUpperCase().replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
                if (/^[A-Z]/.test(s)) return s;
                return parseInt(s.replace(/[^0-9]/g, '')) || 0;
              };
              const valA = parseBout(a.data.bout);
              const valB = parseBout(b.data.bout);
              if (typeof valA === 'number' && typeof valB === 'number') return valA - valB;
              return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
            });

          const standbyRaw: typeof ringQueueAll = [];
          if (ring.onDeck) {
            standbyRaw.push({ id: `ondeck-${ring.ringNumber}`, data: ring.onDeck });
          }
          if (ring.inTheHole) {
            standbyRaw.push({ id: `inthehole-${ring.ringNumber}`, data: ring.inTheHole });
          }
          ringQueueAll.forEach(q => {
            const isAlreadyOnDeck = ring.onDeck && isBoutMatch(q.data.bout, ring.onDeck.bout);
            const isAlreadyInTheHole = ring.inTheHole && isBoutMatch(q.data.bout, ring.inTheHole.bout);
            if (!isAlreadyOnDeck && !isAlreadyInTheHole) {
              standbyRaw.push(q);
            }
          });
          const ringQueue = standbyRaw.slice(0, 3);
          const current = ring.currentBout;
          const ringName = namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber);
          const isPoomsaeModeCurrent = current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                               current?.category?.toUpperCase().includes('FREESTYLE') ||
                               (current?.category?.toUpperCase().includes('POOMSAE') && !current.red_name);
          
          return (
            <div key={`${ring.ringNumber}-${i}`} className="grid grid-cols-12 gap-8 items-center">
              {/* Ring Number */}
              <div className="col-span-1 flex flex-col items-center justify-center">
                <div className="text-7xl font-black text-white italic leading-none tracking-tighter">{ringName}</div>
                <div className="text-[10px] font-black text-white uppercase tracking-[0.4em] mt-2 ml-1">Court</div>
              </div>

              {/* Active Match Capsule */}
              <div className="col-span-8">
                <div className="relative">
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 flex items-center gap-3">
                    <div className="h-[1px] w-12 bg-slate-800" />
                    <div className="bg-yellow-400 text-slate-950 px-6 py-1 rounded-full text-[13px] font-black uppercase tracking-[0.2em] whitespace-nowrap shadow-lg shadow-yellow-900/20">
                      {cleanPlaceholder(current?.category || "")}
                    </div>
                    <div className="h-[1px] w-12 bg-slate-800" />
                  </div>
                  
                  <div className={cn(
                    "flex items-center bg-slate-900 rounded-[3rem] border-4 border-slate-800 shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden transition-all duration-500",
                    isFullscreen ? "h-36" : "h-40"
                  )}>
                    {(!current || !hasPlayers(current)) && showEmptyBoutAsInactive ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-slate-500/50 space-y-4 py-8">
                        <AlertCircle size={48} />
                        <p className="text-2xl font-black uppercase tracking-[0.3em]">Ring Inactive</p>
                      </div>
                    ) : (
                      <>
                        {/* Blue Side */}
                        <div className={cn(
                          "flex-1 h-full bg-blue-600 flex flex-col justify-center px-10 relative overflow-hidden group transition-all duration-500",
                          isPoomsaeModeCurrent ? "flex-[10]" : "flex-1"
                        )}>
                          <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-white/20 to-transparent pointer-events-none" />
                          <div className="absolute -right-4 top-1/2 -translate-y-1/2 text-8xl font-black text-white/5 italic select-none">{(!current || !hasPlayers(current)) ? 'BLURRED' : 'BLUE'}</div>
                          <p className="text-[16px] font-black text-yellow-400 uppercase tracking-[0.2em] mb-1 relative z-10 truncate w-full">
                            {current ? cleanPlaceholder(current.blue_club || "") : "---"}
                          </p>
                          <h4 className="font-black text-white uppercase relative z-10 leading-tight text-[25px] break-words whitespace-normal w-full">
                            {current?.privacy_mode || !current?.blue_name ? "---" : cleanPlaceholder(current.blue_name)}
                          </h4>
                        </div>

                        {/* Bout Number Circle */}
                        <div className={cn(
                          "z-20 w-[120px] h-[120px] bg-white rounded-full border-[10px] border-slate-800 flex items-center justify-center shadow-2xl transform hover:scale-105 transition-all",
                          isPoomsaeModeCurrent ? "ml-auto mr-10" : "-mx-10"
                        )}>
                          <span className="text-[36px] font-black text-slate-900 leading-none">
                            {current && hasPlayers(current) ? formatBoutNumber(ring.ringNumber, current.bout, boutNumberingMode) : "---"}
                          </span>
                        </div>

                        {/* Red Side */}
                        {!isPoomsaeModeCurrent && (
                          <div className="flex-1 h-full bg-red-600 flex flex-col justify-center px-10 text-right relative overflow-hidden group">
                            <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-bl from-white/20 to-transparent pointer-events-none" />
                            <div className="absolute -left-4 top-1/2 -translate-y-1/2 text-8xl font-black text-white/5 italic select-none">{(!current || !hasPlayers(current)) ? 'BLURRED' : 'RED'}</div>
                            <p className="text-[16px] font-black text-yellow-400 uppercase tracking-[0.2em] mb-1 relative z-10 truncate w-full text-right">
                              {current ? cleanPlaceholder(current.red_club || "") : "---"}
                            </p>
                            <h4 className="font-black text-white uppercase relative z-10 leading-tight text-[25px] break-words whitespace-normal w-full text-right">
                              {current?.privacy_mode || !current?.red_name ? "---" : cleanPlaceholder(current.red_name)}
                            </h4>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Standby Queue */}
              <div className={cn(
                "col-span-3 transition-all duration-500",
                isFullscreen ? "space-y-2" : "space-y-3"
              )}>
                <div className="flex items-center justify-between px-2">
                  <div className="text-[10px] font-black text-white uppercase tracking-[0.2em] flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-red-600 rounded-full" />
                    Ring {ringName}
                  </div>
                  <div className="text-[9px] font-bold text-white uppercase tracking-widest">Next 3 Bouts</div>
                </div>
                <div className={cn(
                  "transition-all duration-500",
                  isFullscreen ? "space-y-1.5" : "space-y-2.5"
                )}>
                      {[0, 1, 2].map((idx) => {
                        const bout = ringQueue[idx];
                    const isPoomsaeItem = bout?.data?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                                          bout?.data?.category?.toUpperCase().includes('FREESTYLE') ||
                                          (bout?.data?.category?.toUpperCase().includes('POOMSAE') && !bout?.data?.red_name);
                    const isRingInactive = showEmptyBoutAsInactive && (!current || !hasPlayers(current));
                    return (
                      <div key={idx} className="flex items-center bg-slate-900 rounded-full border border-slate-800 overflow-hidden min-h-[2.5rem] py-1 shadow-lg group hover:border-slate-600 transition-colors">
                        {/* Blue Side */}
                        <div className={cn(
                          "self-stretch flex flex-col justify-center px-3 min-w-0 relative transition-all duration-500",
                          isPoomsaeItem ? "flex-[10]" : "flex-1",
                          isRingInactive ? "bg-slate-800" : "bg-blue-600/90"
                        )}>
                          {!isRingInactive && <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />}
                          <p className="text-[9px] font-bold text-yellow-400 uppercase leading-none mb-0.5 relative z-10">
                            {bout ? cleanPlaceholder(bout.data.blue_club) : ""}
                          </p>
                          <p className={cn(
                            "font-black uppercase tracking-[1px] relative z-10 leading-tight line-clamp-2 whitespace-normal break-words",
                            getStandbyDynamicFontSize(bout?.data.blue_name || ""),
                            isRingInactive ? "text-slate-400" : "text-white"
                          )}>
                            {bout ? (bout.data.privacy_mode ? "---" : cleanPlaceholder(bout.data.blue_name)) : ""}
                          </p>
                        </div>
                        
                        {/* Bout Number */}
                        <div className={cn(
                           "z-10 w-10 h-10 bg-white rounded-full border-4 border-slate-900 flex items-center justify-center flex-shrink-0 shadow-xl group-hover:scale-110 transition-transform",
                           isPoomsaeItem ? "ml-auto mr-1" : "-mx-4"
                        )}>
                          <span className="text-[10px] font-black text-slate-900">
                            {bout?.data?.bout ? formatBoutNumber(ring.ringNumber, bout.data.bout, boutNumberingMode) : "---"}
                          </span>
                        </div>

                        {/* Red Side */}
                        {!isPoomsaeItem && (
                          <div className={cn(
                            "flex-1 self-stretch flex flex-col justify-center px-3 min-w-0 text-right relative",
                            isRingInactive ? "bg-slate-800" : "bg-red-600/90"
                          )}>
                            {!isRingInactive && <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-bl from-white/10 to-transparent pointer-events-none" />}
                            <p className="text-[9px] font-bold text-yellow-400 uppercase leading-none mb-0.5 relative z-10">
                              {bout ? cleanPlaceholder(bout.data.red_club) : ""}
                            </p>
                            <p className={cn(
                              "font-black uppercase tracking-[1px] relative z-10 leading-tight line-clamp-2 whitespace-normal break-words",
                              getStandbyDynamicFontSize(bout?.data.red_name || ""),
                              isRingInactive ? "text-slate-400" : "text-white"
                            )}>
                              {bout ? (bout.data.privacy_mode ? "---" : cleanPlaceholder(bout.data.red_name)) : ""}
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {isFullscreen && totalPages > 1 && (
        <div className="flex justify-center gap-3 py-4 flex-shrink-0">
          {Array.from({ length: totalPages }).map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentPage(i)}
              className={cn(
                "w-3 h-3 rounded-full transition-all duration-300",
                currentPage === i 
                  ? "bg-red-600 w-8 shadow-[0_0_15px_rgba(220,38,38,0.5)]" 
                  : "bg-slate-800 hover:bg-slate-700"
              )}
            />
          ))}
        </div>
      )}
      <AnnouncementPopup announcement={activeAnnouncement || null} onClose={onAnnouncementClose || (() => {})} size={isFullscreen ? 'large' : 'normal'} />
    </div>
  );
}

function PublicDashboardView({ 
  rings, 
  boutQueue, 
  namingMode, 
  onBack, 
  isSpectator, 
  showTotalBouts = true, 
  boutNumberingMode = 'alphanumeric', 
  showOnlyActiveRings = false, 
  showEmptyBoutAsInactive = false, 
  showPublicStandbyQueue = true, 
  publicViewLayout = 'standard', 
  selectedEventName = '',
  boutTransfers = [],
  isAdmin = false,
  onDeleteTransfer = () => {}
}: { 
  rings: RingStatus[], 
  boutQueue: {id: string, data: MatchData}[], 
  namingMode: 'number' | 'alphabet', 
  onBack: () => void, 
  isSpectator?: boolean, 
  showTotalBouts?: boolean, 
  boutNumberingMode?: 'numeric' | 'alphanumeric', 
  showOnlyActiveRings?: boolean, 
  showEmptyBoutAsInactive?: boolean, 
  showPublicStandbyQueue?: boolean, 
  publicViewLayout?: 'standard' | 'point', 
  selectedEventName?: string,
  boutTransfers?: BoutTransferBroadcast[],
  isAdmin?: boolean,
  onDeleteTransfer?: (id: string) => void
}) {
  const [logoClicks, setLogoClicks] = React.useState(0);
  const clickTimer = React.useRef<NodeJS.Timeout | null>(null);
  const [isQuotaExceeded, setIsQuotaExceeded] = React.useState(false);

  React.useEffect(() => {
    const handleQuotaExceeded = () => {
      setIsQuotaExceeded(true);
    };
    window.addEventListener('firestore-quota-exceeded', handleQuotaExceeded);
    return () => {
      window.removeEventListener('firestore-quota-exceeded', handleQuotaExceeded);
    };
  }, []);

  const isStrictPublic = import.meta.env.VITE_APP_MODE === 'PUBLIC' || 
    (typeof window !== 'undefined' && (
      new URLSearchParams(window.location.search).get('view') === 'public' ||
      (!new URLSearchParams(window.location.search).has('login') && 
       !new URLSearchParams(window.location.search).has('manage') && 
       !new URLSearchParams(window.location.search).has('operator') && 
       !localStorage.getItem('tkd_user'))
    ));

  const handleLogoClick = () => {
    setLogoClicks(prev => prev + 1);
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => setLogoClicks(0), 1000);
    
    if (logoClicks >= 2) { // 3rd click
      // Only allow exiting if not in strict public mode
      if (!isStrictPublic) {
        onBack();
      }
      setLogoClicks(0);
    }
  };

  const effectiveRings = showOnlyActiveRings ? rings.filter(r => r.currentBout && hasPlayers(r.currentBout)) : rings;

  const displayedRings = effectiveRings;

  return (
    <div className="min-h-[100dvh] bg-slate-900 text-white font-sans overflow-x-hidden flex flex-col">
      {isQuotaExceeded && (
        <div className="bg-gradient-to-r from-red-600 to-amber-600 text-white px-4 py-3 text-center text-xs md:text-sm font-bold flex flex-col sm:flex-row items-center justify-center gap-2 relative z-[100] border-b border-red-700 shadow-md">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 animate-bounce" />
            <span>
              <strong>Firestore Daily Quota Limit Reached!</strong> Real-time cloud syncing is temporarily paused. Your scoreboard operations remain 100% active locally (offline-first mode) and will automatically sync when quota resets tomorrow.
            </span>
          </div>
          <div className="flex gap-4 items-center shrink-0 mt-2 sm:mt-0">
            <a 
              href="https://console.firebase.google.com/project/vocal-vigil-452005-p0/firestore/databases/ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849/data?openUpgradeDialog=true" 
              target="_blank" 
              rel="noopener noreferrer" 
              className="bg-white text-red-700 px-3 py-1 rounded-lg hover:bg-slate-100 transition-colors text-xs font-black uppercase tracking-wider"
            >
              Check Database Quota / Upgrade
            </a>
            <button 
              onClick={() => setIsQuotaExceeded(false)}
              className="text-white hover:text-slate-200 underline text-xs font-bold font-mono py-1 select-none cursor-pointer"
            >
              [Dismiss]
            </button>
          </div>
        </div>
      )}

      {/* Public Header */}
      <header className="p-4 sm:p-5 bg-slate-800 border-b border-slate-700 flex items-center justify-between sticky top-0 z-50 transition-all">
        <div 
          className="flex items-center gap-2.5 cursor-pointer select-none"
          onClick={handleLogoClick}
        >
          <div className="w-8 h-8 sm:w-10 sm:h-10 bg-red-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-red-900/20">
            <Trophy className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div>
            <h1 className="font-black text-lg sm:text-xl leading-tight tracking-tighter">MY-TKD LIVE</h1>
            <p className="text-[9px] sm:text-[10px] text-slate-400 font-bold uppercase tracking-widest font-mono">Web View Dashboard</p>
          </div>
        </div>

        {selectedEventName && (
          <div className="bg-red-600/10 border border-red-500/25 px-3 py-1.5 rounded-xl flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
            <span className="text-[10px] sm:text-xs font-black tracking-widest uppercase text-red-500 font-mono">
              {selectedEventName}
            </span>
          </div>
        )}
      </header>

      <div className="p-3 sm:p-6 md:p-8 space-y-6 md:space-y-8 max-w-[1600px] mx-auto flex-1 w-full">
        <PinnedTransferBanner 
          transfers={boutTransfers} 
          isAdmin={isAdmin} 
          onDelete={onDeleteTransfer} 
        />
        <div className="grid grid-cols-1 gap-6 md:gap-8">
          {/* Mats Grid */}
          <div className="space-y-4 md:space-y-6">
            <h3 className="text-sm sm:text-base md:text-lg font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
              <LayoutDashboard size={18} className="text-red-500" />
              Live Ring Status
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
              {displayedRings.map((ring, i) => {
                const ringQueueAllSorted = boutQueue
                  .filter(q => q.data.ring === ring.ringNumber)
                  .sort((a, b) => {
                    const parseBout = (bout: string | number) => {
                      const s = bout.toString().replace(/\s+/g, '').toUpperCase().replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
                      if (/^[A-Z]/.test(s)) return s;
                      return parseInt(s.replace(/[^0-9]/g, '')) || 0;
                    };
                    const valA = parseBout(a.data.bout);
                    const valB = parseBout(b.data.bout);
                    if (typeof valA === 'number' && typeof valB === 'number') return valA - valB;
                    return String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
                  });

                const standbyRaw: typeof ringQueueAllSorted = [];
                if (ring.onDeck) {
                  standbyRaw.push({ id: `ondeck-${ring.ringNumber}`, data: ring.onDeck });
                }
                if (ring.inTheHole) {
                  standbyRaw.push({ id: `inthehole-${ring.ringNumber}`, data: ring.inTheHole });
                }
                ringQueueAllSorted.forEach(q => {
                  const isAlreadyOnDeck = ring.onDeck && isBoutMatch(q.data.bout, ring.onDeck.bout);
                  const isAlreadyInTheHole = ring.inTheHole && isBoutMatch(q.data.bout, ring.inTheHole.bout);
                  if (!isAlreadyOnDeck && !isAlreadyInTheHole) {
                    standbyRaw.push(q);
                  }
                });

                const isPoomsaeRing = ring.currentBout?.category?.toUpperCase().includes('POOMSAE') || 
                                      ring.currentBout?.category?.toUpperCase().includes('FREESTYLE') ||
                                      (standbyRaw.length > 0 && (
                                        standbyRaw[0].data.category?.toUpperCase().includes('POOMSAE') ||
                                        standbyRaw[0].data.category?.toUpperCase().includes('FREESTYLE')
                                      ));

                const queueLimit = isPoomsaeRing ? 8 : 3;
                const rQueue = standbyRaw.slice(0, queueLimit);
                
                return (
                  <PublicRingCard 
                    key={ring.ringNumber} 
                    ring={ring} 
                    namingMode={namingMode} 
                    queueCount={ringQueueAllSorted.length}
                    showTotalBouts={showTotalBouts}
                    boutNumberingMode={boutNumberingMode}
                    ringQueue={rQueue}
                    showPublicStandbyQueue={showPublicStandbyQueue}
                    showEmptyBoutAsInactive={showEmptyBoutAsInactive}
                    publicViewLayout={publicViewLayout}
                    transfers={boutTransfers}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <footer className="p-6 bg-slate-800 border-t border-slate-700 mt-8 text-center space-y-4">
        <div className="flex flex-col items-center gap-2">
          <div className="w-32 h-32 bg-white p-3 rounded-2xl flex items-center justify-center shadow-xl transition-all duration-300 hover:scale-105 border border-slate-700/50">
            <QRCodeSVG 
              value={`${window.location.protocol}//${window.location.host}${window.location.pathname}?view=public`}
              size={104}
              bgColor="#ffffff"
              fgColor="#0f172a"
              level="H"
            />
          </div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-300 mt-1">Scan for Live Updates</p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <p className="text-[11px] text-slate-500 font-medium">© 2026 MY-TKD Tournament Management System</p>
          {/* Hide back/operator button in public/spectator mode and strict public mode */}
          {!isStrictPublic && !isSpectator && (
            <button 
              onClick={onBack}
              className="px-3.5 py-1.5 bg-slate-700/30 hover:bg-slate-700 text-[10px] text-slate-400 hover:text-white uppercase font-black tracking-widest transition-all mt-2 rounded-lg border border-slate-700/50"
            >
              Exit Public View
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function PublicRingCard({ ring, namingMode, queueCount, showTotalBouts = true, boutNumberingMode = 'alphanumeric', ringQueue, showPublicStandbyQueue = true, showEmptyBoutAsInactive = false, publicViewLayout = 'standard', transfers = [] }: PublicRingCardProps) {
  const [now, setNow] = React.useState(new Date());

  React.useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const current = ring.currentBout;
  const ringName = namingMode === 'number' ? ring.ringNumber.toString() : String.fromCharCode(64 + ring.ringNumber);
  
  const activeTransfersForRing = (transfers || []).filter(t => {
    if (!t.isPinned) return false;
    const expiry = new Date(t.pinnedUntil);
    if (expiry <= now) return false;
    
    const ringNumStr = ring.ringNumber.toString().trim().toUpperCase();
    const ringNameNorm = ringName.trim().toUpperCase();
    const fromRingNorm = t.fromRing.trim().toUpperCase();
    const toRingNorm = t.toRing.trim().toUpperCase();
    
    return fromRingNorm === ringNumStr || fromRingNorm === ringNameNorm ||
           toRingNorm === ringNumStr || toRingNorm === ringNameNorm;
  });

  const isRingInactive = showEmptyBoutAsInactive && (!current || !hasPlayers(current));
  const isPoomsaeModeCurrent = current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                               current?.category?.toUpperCase().includes('FREESTYLE') ||
                               (current?.category?.toUpperCase().includes('POOMSAE') && !current?.red_name);
  
  const formatCategoryName = (cat?: string) => {
    if (!cat) return "";
    // Specifically remove "(INDIVIDUAL POOMSAE)" or "(INDIVIDUAL POOMSAE)-" as requested
    return cat.replace(/\s*\(INDIVIDUAL POOMSAE\)\s*-?/gi, '').trim();
  };

  const groupedQueue = React.useMemo(() => {
    if (!ringQueue) return [];
    
    const result: { category: string; bouts: typeof ringQueue }[] = [];
    ringQueue.forEach(bout => {
      const cat = cleanPlaceholder(bout.data.category) || 'Regular Category';
      const existingGroup = result.find(g => g.category === cat);
      if (existingGroup) {
        existingGroup.bouts.push(bout);
      } else {
        result.push({ category: cat, bouts: [bout] });
      }
    });
    
    return result;
  }, [ringQueue]);
  
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl md:rounded-3xl overflow-hidden shadow-2xl">
      <div className="p-2 sm:p-4 bg-slate-700/50 flex items-center relative">
        <div className="flex items-center gap-1.5 sm:gap-4 z-10 relative">
          <div className="w-8 h-8 sm:w-12 sm:h-12 bg-red-600 rounded-lg sm:rounded-2xl flex items-center justify-center font-black text-sm sm:text-xl shadow-lg shadow-red-900/20">
            {ringName}
          </div>
          <div>
            <h4 className="font-black text-xs sm:text-[20px] uppercase tracking-wider sm:tracking-widest text-white mt-0">Ring {ringName}</h4>
            {!isRingInactive && (
              <div className="flex items-center gap-1.5">
                <div className="w-1 h-1 sm:w-1.5 sm:h-1.5 bg-green-500 rounded-full animate-pulse" />
                <span className="text-[7px] sm:text-[10px] font-bold text-green-500 uppercase tracking-wider sm:tracking-widest">Live Match</span>
              </div>
            )}
          </div>
        </div>
        {current && (
          <div className="absolute top-0 left-0 right-0 bottom-0 flex items-center justify-center pointer-events-none">
            <p className="text-xl sm:text-3xl md:text-[40px] font-black text-white leading-none drop-shadow-md pointer-events-auto translate-x-10">
              {(() => {
                const isTransferred = (() => {
                  if (!current?.bout) return false;
                  const s = current.bout.toString().toUpperCase().trim();
                  const match = s.match(/^([A-Z])/);
                  if (match) {
                    const boutPrefix = match[1];
                    const expectedPrefix = String.fromCharCode(64 + ring.ringNumber);
                    return boutPrefix !== expectedPrefix;
                  }
                  return false;
                })();
                const formBout = hasPlayers(current) ? formatBoutNumber(ring.ringNumber, current.bout, boutNumberingMode) : "---";
                if (isTransferred) {
                  return formBout;
                }
                return (
                  <>
                    {formBout}
                    {showTotalBouts && (
                      <>
                        <span className="mx-1 sm:mx-2 text-white/40">/</span>
                        <span className="text-xs sm:text-2xl md:text-[30px]">{ring.totalBouts ? formatBoutNumber(ring.ringNumber, ring.totalBouts, boutNumberingMode) : (queueCount || 0)}</span>
                      </>
                    )}
                  </>
                );
              })()}
            </p>
          </div>
        )}
      </div>
      
      <div className="p-2.5 sm:p-6 space-y-2.5 sm:space-y-4">
        {activeTransfersForRing.map(t => (
          <div 
            key={t.id} 
            className="bg-yellow-500 text-slate-950 border-2 border-yellow-400 rounded-xl p-2 md:p-3 flex flex-col items-center justify-center text-center gap-1 shadow-[0_4px_12px_rgba(234,179,8,0.15)] animate-pulse"
          >
            <div className="flex items-center gap-1.5 justify-center">
              <Bell size={14} className="shrink-0 text-slate-950 animate-bounce" />
              <span className="text-[9px] font-black uppercase tracking-wider text-slate-800">
                Bout Transfer Broadcast
              </span>
            </div>
            <span className="text-[11px] sm:text-xs font-black uppercase tracking-tight text-slate-950 mt-0.5">
              Court {t.fromRing} ➡️ Court {t.toRing} - Bout {t.boutNumber}
            </span>
          </div>
        ))}
        {(!current || !hasPlayers(current)) && showEmptyBoutAsInactive ? (
          <div className="py-4 sm:py-8 flex flex-col items-center justify-center text-slate-600 space-y-2 sm:space-y-4">
            <AlertCircle className="w-8 h-8 sm:w-12 sm:h-12" />
            <p className="text-[10px] sm:text-sm font-black uppercase tracking-widest">Ring Inactive</p>
          </div>
        ) : (
          <div className="space-y-2.5 sm:space-y-4">
            <div className="flex items-center justify-center">
              <span className="text-[11px] sm:text-base md:text-[20px] font-black text-yellow-400 uppercase tracking-widest text-center leading-tight">
                {current ? cleanPlaceholder(formatCategoryName(current.category)) : "---"}
              </span>
            </div>
            
            {publicViewLayout === 'standard' ? (
              <div className="flex flex-col items-center justify-center gap-2 sm:gap-6 py-1 sm:py-4">
                {/* BLUE SIDE */}
                <div className="text-center space-y-0.5 w-full px-1 sm:px-2">
                  <p className="text-[18px] sm:text-[26px] md:text-[34px] font-black text-[#00a2e8] leading-tight uppercase tracking-tight break-words mx-auto w-full">
                    {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.blue_name)) : ""}
                  </p>
                  <p className="text-white font-black text-[8px] sm:text-sm uppercase tracking-widest leading-snug break-words whitespace-normal w-full">
                    {current ? cleanPlaceholder(current.blue_club) : ""}
                  </p>
                </div>

                {!current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') && 
                  !current?.category?.toUpperCase().includes('FREESTYLE') && 
                  !(current?.category?.toUpperCase().includes('POOMSAE') && !current?.red_name) && (
                  <>
                    <div className="text-[10px] sm:text-xl font-black text-white italic leading-none my-0.5">VS</div>

                    {/* RED SIDE */}
                    <div className="text-center space-y-0.5 w-full px-1 sm:px-2">
                      <p className="text-[18px] sm:text-[26px] md:text-[34px] font-black text-[#ed1c24] leading-tight uppercase tracking-tight break-words mx-auto w-full">
                        {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.red_name)) : ""}
                      </p>
                      <p className="text-white font-black text-[8px] sm:text-sm uppercase tracking-widest leading-snug break-words whitespace-normal w-full">
                        {current ? cleanPlaceholder(current.red_club) : ""}
                      </p>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-3 sm:mt-4 space-y-4 sm:space-y-6">
                {/* Points Table */}
                {!isPoomsaeModeCurrent && (() => {
                  const getRoundWinnerSpec = (roundNum: number) => {
                    const pt = current?.points;
                    if (!pt) return '';
                    const winKey = `r${roundNum}Winner`;
                    const explicitVal = pt[winKey as 'r1Winner' | 'r2Winner' | 'r3Winner'];
                    if (explicitVal === 'Blue' || explicitVal === 'Red') return explicitVal;
                    
                    const blueVal = pt[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'] !== undefined && pt[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'] !== null ? parseInt(pt[`r${roundNum}Blue` as 'r1Blue' | 'r2Blue' | 'r3Blue'] || '') : NaN;
                    const redVal = pt[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'] !== undefined && pt[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'] !== null ? parseInt(pt[`r${roundNum}Red` as 'r1Red' | 'r2Red' | 'r3Red'] || '') : NaN;
                    if (!isNaN(blueVal) && !isNaN(redVal)) {
                      if (blueVal > redVal) return 'Blue';
                      if (redVal > blueVal) return 'Red';
                    }
                    return '';
                  };
                  const r1W = getRoundWinnerSpec(1);
                  const r2W = getRoundWinnerSpec(2);
                  const r3W = getRoundWinnerSpec(3);

                  return (
                    <div className="mx-auto w-full max-w-sm grid grid-cols-3 divide-x divide-slate-800 border border-slate-700 bg-slate-800/80 rounded-lg overflow-hidden">
                      <div className="col-span-3 grid grid-cols-3 divide-x divide-slate-700 bg-green-600 text-white font-black text-center py-1 sm:py-2 text-[11px] sm:text-sm uppercase">
                        <div>R1</div>
                        <div>R2</div>
                        <div>R3</div>
                      </div>
                      <div className="col-span-3 grid grid-cols-3 divide-x divide-slate-800 bg-[#0e1726] text-white font-black text-center text-xl sm:text-2xl border-t border-slate-800 items-center">
                        <div className="flex items-center justify-center py-2 bg-[#0e1726]">
                          <span className={cn(
                            "w-10 h-10 flex items-center justify-center rounded-full font-black text-xl sm:text-2xl transition-all",
                            r1W === 'Blue' ? "text-[#00a2e8] border-2 border-[#00a2e8] bg-[#00a2e8]/15 shadow-md scale-105" : "text-white"
                          )}>
                            {current?.points?.r1Blue || '0'}
                          </span>
                        </div>
                        <div className="flex items-center justify-center py-2 bg-[#0e1726]">
                          <span className={cn(
                            "w-10 h-10 flex items-center justify-center rounded-full font-black text-xl sm:text-2xl transition-all",
                            r2W === 'Blue' ? "text-[#00a2e8] border-2 border-[#00a2e8] bg-[#00a2e8]/15 shadow-md scale-105" : "text-white"
                          )}>
                            {current?.points?.r2Blue || '0'}
                          </span>
                        </div>
                        <div className="flex items-center justify-center py-2 bg-[#0e1726]">
                          <span className={cn(
                            "w-10 h-10 flex items-center justify-center rounded-full font-black text-xl sm:text-2xl transition-all",
                            r3W === 'Blue' ? "text-[#00a2e8] border-2 border-[#00a2e8] bg-[#00a2e8]/15 shadow-md scale-105" : "text-white"
                          )}>
                            {current?.points?.r3Blue || '0'}
                          </span>
                        </div>
                      </div>
                      <div className="col-span-3 grid grid-cols-3 divide-x divide-slate-800 bg-[#0e1726] text-white font-black text-center text-xl sm:text-2xl border-t border-slate-800 items-center">
                        <div className="flex items-center justify-center py-2 bg-[#0e1726]">
                          <span className={cn(
                            "w-10 h-10 flex items-center justify-center rounded-full font-black text-xl sm:text-2xl transition-all",
                            r1W === 'Red' ? "text-[#ed1c24] border-2 border-[#ed1c24] bg-[#ed1c24]/15 shadow-md scale-105" : "text-white"
                          )}>
                            {current?.points?.r1Red || '0'}
                          </span>
                        </div>
                        <div className="flex items-center justify-center py-2 bg-[#0e1726]">
                          <span className={cn(
                            "w-10 h-10 flex items-center justify-center rounded-full font-black text-xl sm:text-2xl transition-all",
                            r2W === 'Red' ? "text-[#ed1c24] border-2 border-[#ed1c24] bg-[#ed1c24]/15 shadow-md scale-105" : "text-white"
                          )}>
                            {current?.points?.r2Red || '0'}
                          </span>
                        </div>
                        <div className="flex items-center justify-center py-2 bg-[#0e1726]">
                          <span className={cn(
                            "w-10 h-10 flex items-center justify-center rounded-full font-black text-xl sm:text-2xl transition-all",
                            r3W === 'Red' ? "text-[#ed1c24] border-2 border-[#ed1c24] bg-[#ed1c24]/15 shadow-md scale-105" : "text-white"
                          )}>
                            {current?.points?.r3Red || '0'}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {!current?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') && 
                  !current?.category?.toUpperCase().includes('FREESTYLE') && 
                  !(current?.category?.toUpperCase().includes('POOMSAE') && !current?.red_name) ? (
                  <div className="grid grid-cols-[1fr,auto,1fr] gap-1.5 sm:gap-4 items-center pb-1">
                    <div className="flex flex-col min-w-0">
                      <div className="h-0.5 w-full bg-[#00a2e8] rounded-full mb-1 sm:mb-2 shadow-[0_0_8px_rgba(0,162,232,0.8)]" />
                      <span className="font-bold text-[#00a2e8] text-[18px] sm:text-[24px] leading-tight whitespace-normal break-words text-center">
                        {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.blue_name)) : ""}
                      </span>
                      <span className="font-bold text-white text-[9px] sm:text-sm leading-tight whitespace-normal break-words text-center mt-0.5">
                        {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.blue_club)) : ""}
                      </span>
                    </div>

                    <div className="text-[10px] sm:text-xl font-black text-white italic pt-1 text-center">VS</div>

                    <div className="flex flex-col min-w-0">
                      <div className="h-0.5 w-full bg-[#ed1c24] rounded-full mb-1 sm:mb-2 shadow-[0_0_8px_rgba(237,28,36,0.8)]" />
                      <span className="font-bold text-[#ed1c24] text-[18px] sm:text-[24px] leading-tight whitespace-normal break-words text-center">
                        {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.red_name)) : ""}
                      </span>
                      <span className="font-bold text-white text-[9px] sm:text-sm leading-tight whitespace-normal break-words text-center mt-0.5">
                        {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.red_club)) : ""}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col max-w-sm mx-auto w-full px-1">
                    <div className="h-0.5 w-full bg-[#00a2e8] rounded-full mb-1 sm:mb-2 shadow-[0_0_8px_rgba(0,162,232,0.8)]" />
                    <span className="font-bold text-[#00a2e8] text-[18px] sm:text-[24px] leading-tight whitespace-normal break-words text-center">
                      {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.blue_name)) : ""}
                    </span>
                    <span className="font-bold text-white text-[9px] sm:text-sm leading-tight whitespace-normal break-words text-center mt-0.5">
                      {current ? (current.privacy_mode ? "---" : cleanPlaceholder(current.blue_club)) : ""}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Public Standby Queue */}
        {!isRingInactive && showPublicStandbyQueue && ringQueue && ringQueue.length > 0 && (
          <div className="mt-4 sm:mt-6 border-t border-slate-700 pt-3 sm:pt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] sm:text-[10px] font-black text-slate-400 uppercase tracking-[0.15em] sm:tracking-[0.2em] flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-yellow-500 rounded-full" />
                Standby Queue
              </span>
              <span className="text-[8px] sm:text-[9px] font-bold text-slate-500 uppercase tracking-widest">Next {ringQueue.length} Bouts</span>
            </div>
            <div className="space-y-3 sm:space-y-4">
              {groupedQueue.map((group, groupIdx) => (
                <div key={groupIdx} className="space-y-1">
                  <div className="text-[8px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1.5 sm:px-2 py-0.5 bg-slate-800 rounded border border-slate-700 w-fit mb-1.5">
                    {formatCategoryName(group.category)}
                  </div>
                  <div className="space-y-1.5 sm:space-y-2">
                    {group.bouts.map((bout, idx) => {
                      const isPoomsaeItem = bout?.data?.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || 
                                            bout?.data?.category?.toUpperCase().includes('FREESTYLE') ||
                                            (bout?.data?.category?.toUpperCase().includes('POOMSAE') && !bout?.data?.red_name);
                      return (
                        <div key={idx} className="flex items-center bg-slate-900 rounded-lg sm:rounded-xl border border-slate-700 overflow-hidden min-h-[2.5rem] sm:min-h-[3rem] shadow-sm">
                          {/* Bout Num */}
                          <div className="w-10 sm:w-12 h-full bg-slate-800 flex items-center justify-center border-r border-slate-700 flex-shrink-0">
                            <span className="text-[12px] sm:text-[14px] font-black text-white">
                              {bout?.data?.bout ? formatBoutNumber(ring.ringNumber, bout.data.bout, boutNumberingMode) : "---"}
                            </span>
                          </div>

                          {/* Blue Side */}
                          <div className={cn(
                            "self-stretch py-1.5 sm:py-2.5 flex flex-col justify-center px-2.5 sm:px-4 relative transition-all duration-500 border-l-[3px] sm:border-l-[4px] min-w-0 overflow-hidden",
                            isPoomsaeItem ? "flex-[10]" : "flex-1 basis-1/2 border-r border-slate-700/50",
                            isRingInactive ? "border-slate-600" : "border-[#00a2e8]"
                          )}>
                            {!isRingInactive && <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-r from-blue-900/10 to-transparent pointer-events-none" />}
                            <p className={cn(
                              "text-[9px] sm:text-[13px] font-bold uppercase leading-normal sm:leading-tight mb-0.5 break-words whitespace-normal",
                              isRingInactive ? "text-slate-400" : "text-white"
                            )}>
                              {bout ? cleanPlaceholder(bout.data.blue_club) : ""}
                            </p>
                            <p className={cn(
                              "text-[12px] sm:text-[17px] font-black uppercase tracking-[0.5px] leading-tight break-words whitespace-normal w-full",
                              isRingInactive ? "text-slate-500" : "text-[#00a2e8]"
                            )}>
                              {bout ? (bout.data.privacy_mode ? "---" : cleanPlaceholder(bout.data.blue_name)) : ""}
                            </p>
                          </div>

                          {/* Red Side */}
                          {!isPoomsaeItem && (
                            <div className={cn(
                              "flex-1 basis-1/2 self-stretch py-1.5 sm:py-2.5 flex flex-col justify-center px-2.5 sm:px-4 relative border-l-[3px] sm:border-l-[4px] min-w-0 overflow-hidden",
                              isRingInactive ? "border-slate-600" : "border-[#ed1c24]"
                            )}>
                              {!isRingInactive && <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-r from-red-900/10 to-transparent pointer-events-none" />}
                              <p className={cn(
                                "text-[9px] sm:text-[13px] font-bold uppercase leading-normal sm:leading-tight mb-0.5 break-words whitespace-normal",
                                isRingInactive ? "text-slate-400" : "text-white"
                              )}>
                                {bout ? cleanPlaceholder(bout.data.red_club) : ""}
                              </p>
                              <p className={cn(
                                "text-[12px] sm:text-[17px] font-black uppercase tracking-[0.5px] leading-tight break-words whitespace-normal w-full",
                                isRingInactive ? "text-slate-500" : "text-[#ed1c24]"
                              )}>
                                {bout ? (bout.data.privacy_mode ? "---" : cleanPlaceholder(bout.data.red_name)) : ""}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PublicFighterSide({ color, name, club, privacy }: { color: 'blue' | 'red', name: string, club: string, privacy: boolean }) {
  const getDynamicFontSize = (name: string) => {
    const len = name.length;
    if (len <= 15) return 'text-[24px]';
    if (len <= 25) return 'text-[20px]';
    if (len <= 35) return 'text-[16px]';
    return 'text-[14px]';
  };

  return (
    <div className="flex-1 space-y-2 relative">
      <div className={cn(
        "h-2 w-full rounded-full shadow-inner",
        color === 'blue' ? "bg-[#00a2e8] shadow-blue-900/50" : "bg-[#ed1c24] shadow-red-900/50"
      )} />
      <p className={cn(
        "font-black text-white tracking-tight leading-tight whitespace-normal break-words",
        getDynamicFontSize(privacy ? "---" : cleanPlaceholder(name))
      )}>
        {privacy ? "---" : cleanPlaceholder(name)}
      </p>
      <p className={cn(
        "text-sm font-bold uppercase tracking-widest whitespace-normal break-words",
        color === 'blue' ? "text-[#00a2e8]" : "text-[#ed1c24]"
      )}>
        {cleanPlaceholder(club)}
      </p>
    </div>
  );
}

function LoginScreen({ onLogin, events, onBack }: { onLogin: (u: string, p: string, eventId?: string) => boolean, events: EventData[], onBack?: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [eventId, setEventId] = useState(() => {
    return events.length > 0 ? events[0].id : '';
  });
  const [error, setError] = useState(false);

  useEffect(() => {
    if (events.length > 0 && !eventId) {
      setEventId(events[0].id);
    }
  }, [events, eventId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onLogin(username, password, eventId)) {
      setError(true);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white p-8 rounded-3xl border border-slate-200 shadow-xl relative"
      >
        {onBack && (
          <button 
            onClick={onBack}
            className="absolute top-6 left-6 p-2 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-red-600 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-red-200 mb-4">
            <Trophy size={32} />
          </div>
          <h1 className="text-2xl font-black text-slate-800 tracking-tighter">MY-TKD LIVE</h1>
          <p className="text-sm text-slate-500 font-bold uppercase tracking-widest mt-1">Tournament Management</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Username</label>
            <div className="relative">
              <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={18} />
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all font-bold"
                placeholder="Enter username"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={18} />
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all font-bold"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1">Event</label>
            <div className="relative">
              <Trophy className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none z-10" size={18} />
              <select
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
                className="w-full pl-12 pr-10 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-red-500 focus:border-red-500 transition-all font-bold relative z-20 appearance-none cursor-pointer"
                required={username !== 'admin' && events.length > 0}
              >
                <option value="" disabled>
                  {events.length === 0 ? "No events available (Admin must create one)" : "Select an Event"}
                </option>
                {events.map((ev, i) => (
                  <option key={`${ev.id}-${i}`} value={ev.id}>{ev.name}</option>
                ))}
              </select>
              {/* Custom dropdown arrow to replace the default one since we use appearance-none */}
              <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none z-30 text-slate-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600">
              <AlertCircle size={18} />
              <p className="text-xs font-bold">Invalid username or password</p>
            </div>
          )}

          <button 
            type="submit"
            className="w-full py-4 bg-red-600 hover:bg-red-700 text-white rounded-2xl font-black uppercase tracking-widest shadow-xl shadow-red-200 transition-all flex items-center justify-center gap-2"
          >
            <LogIn size={20} />
            Login to System
          </button>
        </form>

        <div className="mt-8 pt-8 border-t border-slate-100 text-center">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
            © 2026 MY-TKD Tournament Management System
          </p>
        </div>
      </motion.div>
    </div>
  );
}

function DataUpdater({ 
  setCategories, 
  setClubs 
}: { 
  setCategories: (cats: string[]) => void, 
  setClubs: (clubs: string[]) => void 
}) {
  const [isUpdatingCategory, setIsUpdatingCategory] = useState(false);
  const [isUpdatingClub, setIsUpdatingClub] = useState(false);
  const [selectedRing, setSelectedRing] = useState<number>(1);
  const [message, setMessage] = useState<{ text: string, type: 'success' | 'error' } | null>(null);

  const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/10WgCWYqQpuu6I48jZ9cyZvMb0bbMYIuk0oAArnMKp04/export?format=csv&gid=0";

  const fetchCSV = async () => {
    const response = await fetch(SHEET_CSV_URL);
    if (!response.ok) {
      throw new Error("Failed to fetch data. Please ensure the Google Sheet is published to the web (File > Share > Publish to web) or is accessible to 'Anyone with the link'.");
    }
    const csvText = await response.text();
    return new Promise<Papa.ParseResult<string[]>>((resolve, reject) => {
      Papa.parse(csvText, {
        complete: resolve,
        error: reject,
        skipEmptyLines: true
      });
    });
  };

  const handleUpdateCategory = async () => {
    setIsUpdatingCategory(true);
    setMessage(null);
    try {
      const result = await fetchCSV();
      const rows = result.data;
      if (rows.length < 2) throw new Error("Sheet is empty or missing data.");
      
      // Ring 1 is col 0 (A), Ring 2 is col 1 (B), etc.
      const colIndex = selectedRing - 1;
      const newCategories: string[] = [];
      
      // Start from row 1 (A2)
      for (let i = 1; i < rows.length; i++) {
        const cat = rows[i][colIndex];
        if (cat && cat.trim() !== '') {
          newCategories.push(cat.trim());
        }
      }
      
      if (newCategories.length === 0) {
        throw new Error(`No categories found for Ring ${selectedRing} in column ${String.fromCharCode(65 + colIndex)}.`);
      }
      
      setCategories(newCategories);
      setMessage({ text: `Successfully updated ${newCategories.length} categories for Ring ${selectedRing}.`, type: 'success' });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "An error occurred.", type: 'error' });
    } finally {
      setIsUpdatingCategory(false);
    }
  };

  const handleUpdateClub = async () => {
    setIsUpdatingClub(true);
    setMessage(null);
    try {
      const result = await fetchCSV();
      const rows = result.data;
      if (rows.length < 2) throw new Error("Sheet is empty or missing data.");
      
      // Clubs are in column Z (index 25)
      const colIndex = 25;
      const newClubs: string[] = [];
      
      // Start from row 1 (Z2)
      for (let i = 1; i < rows.length; i++) {
        const club = rows[i][colIndex];
        if (club && club.trim() !== '') {
          newClubs.push(club.trim());
        }
      }
      
      if (newClubs.length === 0) {
        throw new Error("No clubs found in column Z.");
      }
      
      setClubs(newClubs);
      setMessage({ text: `Successfully updated ${newClubs.length} clubs.`, type: 'success' });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "An error occurred.", type: 'error' });
    } finally {
      setIsUpdatingClub(false);
    }
  };

  return (
    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
      <h3 className="text-xl font-bold flex items-center gap-2">
        <Database size={24} className="text-slate-400" />
        Data Synchronization
      </h3>
      
      {message && (
        <div className={cn("p-4 rounded-xl text-sm font-bold border", message.type === 'success' ? "bg-green-50 text-green-700 border-green-100" : "bg-red-50 text-red-600 border-red-100")}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="p-6 bg-slate-50 rounded-xl border border-slate-100 space-y-4 flex flex-col">
          <div>
            <h4 className="font-bold text-slate-800">Update Category</h4>
            <p className="text-[10px] text-slate-500 mt-1">Fetch categories from Google Sheet for a specific ring.</p>
          </div>
          
          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Select Ring</label>
            <select 
              value={isNaN(selectedRing) ? '' : selectedRing}
              onChange={(e) => setSelectedRing(parseInt(e.target.value) || 1)}
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map(num => (
                <option key={num} value={num}>Ring {num}</option>
              ))}
            </select>
          </div>

          <div className="mt-auto pt-4">
            <button 
              onClick={handleUpdateCategory}
              disabled={isUpdatingCategory}
              className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isUpdatingCategory ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
              Update Category
            </button>
          </div>
        </div>

        <div className="p-6 bg-slate-50 rounded-xl border border-slate-100 space-y-4 flex flex-col">
          <div>
            <h4 className="font-bold text-slate-800">Update Club</h4>
            <p className="text-[10px] text-slate-500 mt-1">Fetch club names from column Z in the Google Sheet.</p>
          </div>
          
          <div className="mt-auto pt-4">
            <button 
              onClick={handleUpdateClub}
              disabled={isUpdatingClub}
              className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isUpdatingClub ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
              Update Club
            </button>
          </div>
        </div>
      </div>
      
      <div className="p-4 bg-blue-50 text-blue-800 rounded-xl text-xs font-medium border border-blue-100">
        <strong>Note:</strong> For this to work, the Google Sheet must be accessible. Please ensure you have set the sharing settings to <strong>"Anyone with the link"</strong> can view.
      </div>
    </div>
  );
}

function EventManagement({ events, onAdd, onDelete, onUpdate }: { events: EventData[], onAdd: (e: EventData) => void, onDelete: (id: string) => void, onUpdate: (e: EventData) => void }) {
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [ringQuantity, setRingQuantity] = useState(1);
  const [sheetUrl, setSheetUrl] = useState('');
  const [winnerSheetUrl, setWinnerSheetUrl] = useState('');
  const [showSyncScript, setShowSyncScript] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean, message: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  const startEdit = (ev: EventData) => {
    setEditingEventId(ev.id);
    setName(ev.name);
    setEventDate(ev.eventDate || '');
    setRingQuantity(ev.ringQuantity || 1);
    setSheetUrl(ev.sheetUrl || '');
    setWinnerSheetUrl(ev.winnerSheetUrl || '');
  };

  const cancelEdit = () => {
    setEditingEventId(null);
    setName('');
    setEventDate('');
    setRingQuantity(1);
    setSheetUrl('');
    setWinnerSheetUrl('');
  };

  const handleTestSync = async () => {
    const activeTestUrl = sheetUrl.trim() || 'https://script.google.com/macros/s/AKfycbxG7SG0HB8WPom3-Pknpjy0Da2bupLF4s7cmqhRci-gosmcATjZubldik7kacnlLoIq/exec';
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testSync(activeTestUrl);
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: 'Test failed: Connection error' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSendTrialBout = async () => {
    const activeTestUrl = sheetUrl.trim() || 'https://script.google.com/macros/s/AKfycbxG7SG0HB8WPom3-Pknpjy0Da2bupLF4s7cmqhRci-gosmcATjZubldik7kacnlLoIq/exec';
    setIsTesting(true);
    setTestResult(null);
    try {
      const trialMatch: MatchData = {
        ring: 9,
        bout: 999,
        category: 'TRIAL TEST RUN',
        blue_name: 'TEST BLUE PLAYER',
        blue_club: 'TRIAL CLUB BLUE',
        red_name: 'TEST RED PLAYER',
        red_club: 'TRIAL CLUB RED',
        privacy_mode: false,
        points: {
          r1Blue: '12', r1Red: '10', r1Winner: 'Blue',
          r2Blue: '8', r2Red: '9', r2Winner: 'Red',
          r3Blue: '15', r3Red: '14', r3Winner: 'Blue'
        }
      };
      
      const success = await rawSyncToGoogleSheets(activeTestUrl, trialMatch, 'TRIAL SYNC TEST', 'TEST TRIAL RUN PAYLOAD');
      if (success) {
        setTestResult({ 
          success: true, 
          message: 'Trial match sent successfully! Open your Google Sheet to verify if "Ring 9, Bout 999" has been inserted.' 
        });
      } else {
        setTestResult({ 
          success: false, 
          message: 'Failed to send trial match row. Double check your Web App deployment settings.' 
        });
      }
    } catch (e: any) {
      setTestResult({ 
        success: false, 
        message: `Error sending trial batch: ${e?.message || 'Network issue'}` 
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Auto-detect and handle plain docs URLs for the Web App field if needed (though it should be /exec)
    const finalSheetUrl = sheetUrl.trim() || 'https://script.google.com/macros/s/AKfycbxG7SG0HB8WPom3-Pknpjy0Da2bupLF4s7cmqhRci-gosmcATjZubldik7kacnlLoIq/exec';
    const finalWinnerUrl = winnerSheetUrl.trim();

    if (editingEventId) {
      const original = events.find(ev => ev.id === editingEventId);
      onUpdate({
        id: editingEventId,
        name,
        eventDate,
        ringQuantity,
        sheetUrl: finalSheetUrl,
        winnerSheetUrl: finalWinnerUrl,
        createdAt: original ? original.createdAt : new Date()
      });
      setEditingEventId(null);
    } else {
      onAdd({
        id: Math.random().toString(36).substr(2, 9),
        name,
        eventDate,
        ringQuantity,
        sheetUrl: finalSheetUrl,
        winnerSheetUrl: finalWinnerUrl,
        createdAt: new Date()
      });
    }
    setName('');
    setEventDate('');
    setRingQuantity(1);
    setSheetUrl('');
    setWinnerSheetUrl('');
  };

  return (
    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <Calendar size={24} className="text-slate-400" />
          Event Management
        </h3>
        <a 
          href="https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/edit?usp=sharing" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline flex items-center gap-1 font-bold"
        >
          View Master Spreadsheet
        </a>
        <button 
          onClick={() => setShowSyncScript(!showSyncScript)}
          className="text-[10px] bg-slate-100 px-3 py-1 rounded-full font-black text-slate-500 uppercase tracking-widest hover:bg-slate-200 transition-all ml-2"
        >
          {showSyncScript ? 'Hide Script' : 'Sync Script Helper'}
        </button>
      </div>

      {showSyncScript && (
        <motion.div 
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="p-6 bg-blue-50 border border-blue-100 rounded-2xl space-y-4"
        >
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black text-blue-900 uppercase tracking-widest">Google Apps Script (Updated)</h4>
            <span className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded font-black">STABLE</span>
          </div>
          <p className="text-xs text-blue-700 font-medium leading-relaxed">
            Copy and paste this script into your Google Sheets <strong>Extensions &gt; Apps Script</strong>. 
            This updated version supports real-time name and club updates from the dashboard.
          </p>
          <pre className="bg-white p-4 text-[10px] font-mono rounded-xl border border-blue-100 overflow-x-auto text-slate-700 shadow-inner">
{`function isGasBoutMatch(b1, b2) {
  if (b1 == b2) return true;
  if (!b1 || !b2) return false;
  
  var s1 = String(b1).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  var s2 = String(b2).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
  
  if (s1 === s2) return true;
  
  // Normalize O to 0 (e.g. CO1 to C01)
  s1 = s1.replace(/^([A-H])O+(\d+)/, '$10$2');
  s2 = s2.replace(/^([A-H])O+(\d+)/, '$10$2');
  if (s1 === s2) return true;

  // Compare numerical values
  var n1 = parseInt(s1.replace(/[^0-9]/g, ''), 10);
  var n2 = parseInt(s2.replace(/[^0-9]/g, ''), 10);
  if (!isNaN(n1) && !isNaN(n2)) {
    if (n1 >= 1000 && n2 < 1000 && n1 % 1000 === n2) return true;
    if (n2 >= 1000 && n1 < 1000 && n2 % 1000 === n1) return true;
    if (n1 >= 1000 && n2 >= 1000) {
      if (Math.floor(n1 / 1000) !== Math.floor(n2 / 1000)) {
        return false;
      }
      return n1 % 1000 === n2 % 1000;
    }
  }
  
  // Normalize leading zeros in prefix format (e.g. "B02" and "B2")
  var getStandard = function(val) {
    var match = val.match(/^([A-Z])0*(\d+)/);
    if (match) {
      return match[1] + match[2];
    }
    return val;
  };
  
  return getStandard(s1) === getStandard(s2);
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    data = e.parameter;
  }
  
  if (data.action === 'ping') {
    return ContentService.createTextOutput("Pong").setMimeType(ContentService.MimeType.TEXT);
  }
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Sheet 1") || ss.getSheets()[0];
  if (!sheet) {
    return ContentService.createTextOutput("Error: Sheet not found");
  }
  
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  // Helper to normalize ring numbers or alphabetic ring letters cleanly
  function normalizeRing(val) {
    if (val === undefined || val === null) return 0;
    var s = String(val).trim().toUpperCase();
    if (!s) return 0;
    
    // Extract only letters and digits
    var letters = s.replace(/[^A-Z]/g, '');
    var digits = s.replace(/[^0-9]/g, '');
    
    // If there is a single letter total, e.g. "A" or "RING A"
    if (letters.length === 1) {
      return letters.charCodeAt(0) - 64;
    }
    // Else check if there are digits
    if (digits.length > 0) {
      return parseInt(digits, 10);
    }
    
    // Fallback single letter search
    var singleLetterMatch = s.match(/(?:^|[^A-Z])([A-Z])(?:$|[^A-Z])/);
    if (singleLetterMatch) {
      return singleLetterMatch[1].charCodeAt(0) - 64;
    }
    return 0;
  }

  // Helper to check if event name matches
  function isEventMatch(rowEventVal, targetEventVal) {
    var rE = String(rowEventVal || '').trim().toUpperCase();
    var tE = String(targetEventVal || '').trim().toUpperCase();
    if (!targetEventVal || tE === '' || tE === '-' || tE === 'N/A' || tE === 'UNDEFINED') return true;
    if (rE === '' || rE === '-' || rE === 'N/A' || rE === 'UNDEFINED') return true;
    if (rE === tE) return true;
    var normRE = rE.replace(/[^A-Z0-9]/g, '');
    var normTE = tE.replace(/[^A-Z0-9]/g, '');
    return normRE === normTE;
  }
  
  function isGasBoutMatch(b1, b2) {
    if (b1 == b2) return true;
    if (!b1 || !b2) return false;
    
    var s1 = String(b1).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
    var s2 = String(b2).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
    
    if (s1 === s2) return true;

    // Suffix alignment
    var getSuffix = function(str) {
      var match = str.match(/([0-9]+)([A-Z]+)$/);
      return match ? match[2] : '';
    };
    if (getSuffix(s1) !== getSuffix(s2)) return false;

    // Normalize O to 0
    s1 = s1.replace(/^([A-H])O+(\d+)/, '$10$2');
    s2 = s2.replace(/^([A-H])O+(\d+)/, '$10$2');
    if (s1 === s2) return true;

    var n1 = parseInt(s1.replace(/[^0-9]/g, ''), 10);
    var n2 = parseInt(s2.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n1) && !isNaN(n2)) {
      if (n1 === n2) return true;
      if (n1 >= 1000 && n2 < 1000 && n1 % 1000 === n2) return true;
      if (n2 >= 1000 && n1 < 1000 && n2 % 1000 === n1) return true;
      if (n1 >= 1000 && n2 >= 1000) {
        return (Math.floor(n1 / 1000) === Math.floor(n2 / 1000)) && (n1 % 1000 === n2 % 1000);
      }
    }

    var getStandard = function(val) {
      var match = val.match(/^([A-Z])0*(\d+)/);
      if (match) {
        return match[1] + match[2];
      }
      return val;
    };

    return getStandard(s1) === getStandard(s2);
  }

  function isTargetBout(row, targetBout) {
    if (!targetBout) return false;
    if (row[17] !== undefined && row[17] !== '' && isGasBoutMatch(row[17], targetBout)) return true;
    if (row[3] !== undefined && row[3] !== '' && isGasBoutMatch(row[3], targetBout)) return true;
    return false;
  }

  function isPlaceholder(val) {
    if (!val) return true;
    var s = String(val).trim().toUpperCase();
    var placeholders = ["-", "--", "---", "N/A", "NEW COMPETITOR", "CLUB A", "CLUB B", "OPEN CATEGORY", "UNDEFINED", "NULL", ""];
    return placeholders.indexOf(s) !== -1;
  }

  function isRowMatch(row, data) {
    if (!data) return false;
    
    // 1. Event Criteria
    var eventMatches = isEventMatch(row[1], data.event_name);
    if (!eventMatches) return false;
    
    // 2. Ring Criteria
    var rowRing = normalizeRing(row[2]);
    var targetRing = normalizeRing(data.ring);
    var ringMatches = (rowRing === 0 || targetRing === 0) ? true : (rowRing === targetRing);
    if (!ringMatches) return false;
    
    // 3. Bout Criteria
    return isTargetBout(row, data.bout);
  }
  
  if (data.action === 'updateBoutDetails') {
    for (let i = 1; i < values.length; i++) {
      if (isRowMatch(values[i], data)) {
        sheet.getRange(i + 1, 6).setValue(data.blue_name);
        sheet.getRange(i + 1, 7).setValue(data.blue_club);
        sheet.getRange(i + 1, 8).setValue(data.red_name);
        sheet.getRange(i + 1, 9).setValue(data.red_club);
        break;
      }
    }
    return ContentService.createTextOutput("Bout Details Updated");
  }

  if (data.action === 'updatePoints') {
    for (let i = 1; i < values.length; i++) {
      if (isRowMatch(values[i], data)) {
        if (data.r1Blue !== undefined) sheet.getRange(i + 1, 10).setValue(data.r1Blue);
        if (data.r1Red !== undefined) sheet.getRange(i + 1, 11).setValue(data.r1Red);
        if (data.r2Blue !== undefined) sheet.getRange(i + 1, 12).setValue(data.r2Blue);
        if (data.r2Red !== undefined) sheet.getRange(i + 1, 13).setValue(data.r2Red);
        if (data.r3Blue !== undefined) sheet.getRange(i + 1, 14).setValue(data.r3Blue);
        if (data.r3Red !== undefined) sheet.getRange(i + 1, 15).setValue(data.r3Red);
        break;
      }
    }
    return ContentService.createTextOutput("Points Updated");
  }

  if (data.action === 'updateWinner') {
    for (let i = 1; i < values.length; i++) {
      if (isRowMatch(values[i], data)) {
        sheet.getRange(i + 1, 16).setValue(data.winner);
        sheet.getRange(i + 1, 17).setValue(data.winner_club);
        // Sync player details during winner update if provided (only if not a placeholder/meaningless symbol)
        if (!isPlaceholder(data.blue_name)) {
          sheet.getRange(i + 1, 6).setValue(data.blue_name);
        }
        if (!isPlaceholder(data.blue_club)) {
          sheet.getRange(i + 1, 7).setValue(data.blue_club);
        }
        if (!isPlaceholder(data.red_name)) {
          sheet.getRange(i + 1, 8).setValue(data.red_name);
        }
        if (!isPlaceholder(data.red_club)) {
          sheet.getRange(i + 1, 9).setValue(data.red_club);
        }
        // Also update points if they are supplied in winner update
        if (data.r1Blue !== undefined) sheet.getRange(i + 1, 10).setValue(data.r1Blue);
        if (data.r1Red !== undefined) sheet.getRange(i + 1, 11).setValue(data.r1Red);
        if (data.r2Blue !== undefined) sheet.getRange(i + 1, 12).setValue(data.r2Blue);
        if (data.r2Red !== undefined) sheet.getRange(i + 1, 13).setValue(data.r2Red);
        if (data.r3Blue !== undefined) sheet.getRange(i + 1, 14).setValue(data.r3Blue);
        if (data.r3Red !== undefined) sheet.getRange(i + 1, 15).setValue(data.r3Red);
        break;
      }
    }
    return ContentService.createTextOutput("Winner Updated");
  }

  if (data.action === 'updateTransfer') {
    for (let i = 1; i < values.length; i++) {
      if (isRowMatch(values[i], data)) {
        sheet.getRange(i + 1, 16).setValue("TRANSFERRED: " + data.reason);
        break;
      }
    }
    return ContentService.createTextOutput("Transfer Updated");
  }
  
  if (data.action === 'newBout') {
    var foundIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (isRowMatch(values[i], data)) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex !== -1) {
      if (!isPlaceholder(data.blue_name)) {
        sheet.getRange(foundIndex + 1, 6).setValue(data.blue_name);
      }
      if (!isPlaceholder(data.blue_club)) {
        sheet.getRange(foundIndex + 1, 7).setValue(data.blue_club);
      }
      if (!isPlaceholder(data.red_name)) {
        sheet.getRange(foundIndex + 1, 8).setValue(data.red_name);
      }
      if (!isPlaceholder(data.red_club)) {
        sheet.getRange(foundIndex + 1, 9).setValue(data.red_club);
      }
      if (data.category && data.category !== '-' && data.category !== 'N/A') {
        sheet.getRange(foundIndex + 1, 5).setValue(data.category);
      }
      return ContentService.createTextOutput("Bout Details Updated (Existing Row)");
    } else {
      sheet.appendRow([
        data.timestamp || new Date().toLocaleString(),
        data.event_name,
        data.ring,
        data.bout,
        data.category,
        data.blue_name,
        data.blue_club,
        data.red_name,
        data.red_club,
        data.r1Blue || '',
        data.r1Red || '',
        data.r2Blue || '',
        data.r2Red || '',
        data.r3Blue || '',
        data.r3Red || '',
        data.winner || '',
        data.winner_club || '',
        data.bout
      ]);
      return ContentService.createTextOutput("New Bout Registered");
    }
  }
  return ContentService.createTextOutput("Success");
}`}
          </pre>
        </motion.div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
        <div className="space-y-1 md:col-span-1">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Event Name</label>
          <input 
            type="text" 
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
            placeholder="e.g. National Open 2026"
            required
          />
        </div>
        <div className="space-y-1 md:col-span-1">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Event Date</label>
          <input 
            type="date" 
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
            required
          />
        </div>
        <div className="space-y-1 md:col-span-1">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Ring Quantity</label>
          <input 
            type="number" 
            min="1"
            max="20"
            value={isNaN(ringQuantity) ? '' : ringQuantity}
            onChange={(e) => setRingQuantity(parseInt(e.target.value))}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
            required
          />
        </div>
        <div className="space-y-1 md:col-span-1">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Live Sync Web App URL</label>
          <input 
            type="text" 
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
            className={cn(
              "w-full px-3 py-2 bg-slate-50 border rounded-xl text-sm font-bold",
              sheetUrl && !sheetUrl.includes('/exec') ? "border-amber-300 bg-amber-50" : "border-slate-200"
            )}
            placeholder="Ends with /exec (Blank = Default)"
          />
          {sheetUrl && !sheetUrl.includes('/exec') && (
            <p className="text-[9px] text-amber-600 font-bold mt-1 ml-1 animate-pulse">
              ⚠️ Warning: URL should end with /exec
            </p>
          )}
        </div>
        <div className="space-y-1 md:col-span-1">
          <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Winner Report Sheet URL</label>
          <input 
            type="text" 
            value={winnerSheetUrl}
            onChange={(e) => setWinnerSheetUrl(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
            placeholder="Standard docs.google.com URL..."
          />
        </div>
        <div className="flex gap-2 w-full md:col-span-2 lg:col-span-1">
          <button 
            type="submit"
            className="flex-1 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all h-[38px]"
          >
            {editingEventId ? 'Update Event' : 'Create Event'}
          </button>
          {editingEventId && (
            <button 
              type="button"
              onClick={cancelEdit}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-[10px] uppercase tracking-widest transition-all h-[38px]"
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {/* 📡 Live Connection & Trial Testing Card */}
      <div className="p-5 bg-slate-50 rounded-xl border border-slate-200/60 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h4 className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-1.5">
              <span>📡</span> Live Script & Data Sync Test
            </h4>
            <p className="text-[10px] text-slate-500 mt-0.5">Test your Live Sync Web App URL with a silent ping or by pushing a real trial match row.</p>
          </div>
          <span className="text-[9px] font-bold text-slate-400 bg-slate-200/50 px-2 py-0.5 rounded self-start sm:self-auto truncate max-w-[250px]">
            Target: {sheetUrl ? sheetUrl : 'Default Master App'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleTestSync}
            disabled={isTesting}
            className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 text-slate-700 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 h-[34px]"
          >
            {isTesting ? <RefreshCw size={12} className="animate-spin" /> : null}
            Send Silent Ping Test
          </button>
          
          <button
            type="button"
            onClick={handleSendTrialBout}
            disabled={isTesting}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 h-[34px]"
          >
            {isTesting ? <RefreshCw size={12} className="animate-spin" /> : null}
            Send Trial Match Row (Bout 999)
          </button>
        </div>

        {testResult && (
          <div className={cn(
            "p-3 rounded-xl border text-xs font-semibold md:font-bold animate-fadeIn",
            testResult.success 
              ? "bg-green-50 border-green-200 text-green-800" 
              : "bg-red-50 border-red-200 text-red-800"
          )}>
            <div className="flex items-start gap-2">
              <span className="text-sm">{testResult.success ? '✅' : '❌'}</span>
              <div>
                <p className="font-black text-xs uppercase tracking-wider">{testResult.success ? 'Success!' : 'Failed'}</p>
                <p className="text-[11px] mt-0.5 font-bold leading-relaxed">{testResult.message}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {events.map((ev, i) => (
          <div key={`${ev.id}-${i}`} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
            <div className="min-w-0 flex-1 mr-4">
              <p className="text-sm font-bold text-slate-800 truncate">{ev.name}</p>
              <p className="text-[10px] text-slate-500">
                {ev.ringQuantity} Rings • Date: {ev.eventDate || 'Not set'}
              </p>
              {ev.sheetUrl && (
                <p className="text-[9px] text-slate-400 truncate mt-0.5">
                  Sync: {ev.sheetUrl}
                </p>
              )}
              {ev.winnerSheetUrl && (
                <p className="text-[9px] text-slate-400 truncate">
                  Report: {ev.winnerSheetUrl}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button 
                onClick={() => startEdit(ev)}
                className="p-2 text-slate-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-colors"
                title="Edit Event"
              >
                <Edit2 size={16} />
              </button>
              <button 
                onClick={() => onDelete(ev.id)}
                className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                title="Delete Event"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
        {events.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-4">No events created yet.</p>
        )}
      </div>
    </div>
  );
}

function UserManagement({ accounts, onAdd, onDelete, onEditPassword }: { accounts: UserAccount[], onAdd: (a: UserAccount) => void, onDelete: (u: string) => void, onEditPassword: (u: string, p: string) => void }) {
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user' | 'ta' | 'viewer'>('user');
  const [assignedRing, setAssignedRing] = useState<number>(1);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editPasswordValue, setEditPasswordValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newUsername && newPassword) {
      onAdd({
        username: newUsername,
        password: newPassword,
        role: newRole,
        assignedRing: newRole === 'user' ? assignedRing : undefined
      });
      setNewUsername('');
      setNewPassword('');
    }
  };

  return (
    <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
      <h3 className="text-xl font-bold text-slate-800 mb-6 flex items-center gap-2">
        <UserPlus className="text-red-500" size={24} />
        User Management
      </h3>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Add User Form */}
        <div className="lg:col-span-1 p-6 bg-slate-50 rounded-2xl border border-slate-100">
          <h4 className="font-bold text-slate-800 mb-4 text-sm uppercase tracking-widest">Add New Account</h4>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Username</label>
              <input 
                type="text" 
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold"
                placeholder="e.g. ring2"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Password</label>
              <input 
                type="text" 
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold"
                placeholder="e.g. 1234"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Role</label>
              <select 
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as 'admin' | 'user' | 'ta' | 'viewer')}
                className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold"
              >
                <option value="user">Ring Controller</option>
                <option value="admin">System Admin</option>
                <option value="ta">Tournament Assistant (TA)</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            {newRole === 'user' && (
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Assigned Ring</label>
                <input 
                  type="number" 
                  value={isNaN(assignedRing) ? '' : assignedRing}
                  onChange={(e) => setAssignedRing(parseInt(e.target.value))}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm font-bold"
                  min="1"
                />
              </div>
            )}
            <button 
              type="submit"
              className="w-full py-3 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold text-xs uppercase tracking-widest transition-all"
            >
              Create Account
            </button>
          </form>
        </div>

        {/* User List */}
        <div className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left border-b border-slate-100">
                  <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Username</th>
                  <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Password</th>
                  <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Role</th>
                  <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Access</th>
                  <th className="pb-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {accounts.map((acc) => (
                  <tr key={acc.username} className="group">
                    <td className="py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center text-slate-500">
                          <UserIcon size={16} />
                        </div>
                        <span className="font-bold text-slate-700">{acc.username}</span>
                      </div>
                    </td>
                    <td className="py-4">
                      <div className="flex items-center gap-2">
                        <Key size={12} className="text-slate-300" />
                        {editingUser === acc.username ? (
                          <div className="flex items-center gap-2">
                            <input 
                              type="text" 
                              value={editPasswordValue} 
                              onChange={e => setEditPasswordValue(e.target.value)} 
                              className="w-24 px-2 py-1 text-xs border border-slate-200 rounded outline-none focus:border-red-500"
                            />
                            <button onClick={() => { onEditPassword(acc.username, editPasswordValue); setEditingUser(null); }} className="text-green-600 hover:text-green-700"><Check size={14}/></button>
                            <button onClick={() => setEditingUser(null)} className="text-red-600 hover:text-red-700"><X size={14}/></button>
                          </div>
                        ) : (
                          <>
                            <span className="font-mono text-xs font-bold text-slate-600">{acc.password}</span>
                            <button onClick={() => { setEditingUser(acc.username); setEditPasswordValue(acc.password); }} className="text-slate-400 hover:text-blue-600 ml-2"><Edit2 size={12}/></button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="py-4">
                      <span className={cn(
                        "px-2 py-1 rounded-lg text-[10px] font-bold uppercase",
                        acc.role === 'admin' ? "bg-red-50 text-red-600" : 
                        acc.role === 'ta' ? "bg-purple-50 text-purple-600" :
                        acc.role === 'viewer' ? "bg-green-50 text-green-600" :
                        "bg-blue-50 text-blue-600"
                      )}>
                        {acc.role}
                      </span>
                    </td>
                    <td className="py-4 text-xs font-bold text-slate-500">
                      {acc.role === 'admin' ? "Full System" : 
                       acc.role === 'ta' ? "Tournament Assistant" :
                       acc.role === 'viewer' ? "View Only" :
                       `Ring ${acc.assignedRing}`}
                    </td>
                    <td className="py-4">
                      {acc.username !== 'admin' && (
                        <button 
                          onClick={() => onDelete(acc.username)}
                          className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function PublicQueueItem({ label, data }: { label: string, data: MatchData | null }) {
  return (
    <div className="p-4 bg-slate-900/50 rounded-2xl border border-slate-700/50">
      <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mb-2">{label}</p>
      {data ? (
        <div className="space-y-1">
          <p className="text-xs font-black text-slate-300 truncate">
            {data.privacy_mode ? "---" : data.blue_name} vs {data.privacy_mode ? "---" : data.red_name}
          </p>
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{data.blue_club} / {data.red_club}</p>
        </div>
      ) : (
        <p className="text-xs font-bold text-slate-700 uppercase tracking-widest">TBD</p>
      )}
    </div>
  );
}
