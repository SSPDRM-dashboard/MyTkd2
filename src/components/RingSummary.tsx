import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Trophy, 
  Clock, 
  TrendingUp, 
  CheckCircle, 
  AlertCircle, 
  Layers, 
  Eye, 
  EyeOff, 
  Search, 
  Sliders, 
  Play, 
  FastForward, 
  ChevronDown, 
  ChevronUp, 
  Filter
} from 'lucide-react';
import { RingStatus, MatchData, MatchHistoryItem } from '../types';
import { formatBoutNumber, getBoutNumber } from '../lib/utils';

interface RingSummaryProps {
  rings: RingStatus[];
  boutQueue: { id: string; data: MatchData }[];
  matchHistory: MatchHistoryItem[];
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  ringNamingMode?: 'number' | 'alphabet';
  currentEventId: string | null;
}

export function RingSummary({ 
  rings, 
  boutQueue, 
  matchHistory, 
  boutNumberingMode = 'alphanumeric', 
  ringNamingMode = 'alphabet',
  currentEventId 
}: RingSummaryProps) {
  // Config state for estimated minutes per match
  const [minsPerMatch, setMinsPerMatch] = useState<number>(6);
  const [ringMins, setRingMins] = useState<Record<number, number>>(() => {
    try {
      const saved = localStorage.getItem('tkd_ring_summary_mins_per_match');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  });
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedRingFilter, setSelectedRingFilter] = useState<number | 'all'>('all');
  const [expandedRing, setExpandedRing] = useState<Record<number, boolean>>({});

  // Helper to format ring name
  const getRingName = (num: number) => {
    if (ringNamingMode === 'number') return num.toString();
    return String.fromCharCode(64 + num); // 1 -> A, 2 -> B, etc.
  };

  // Helper to robustly extract ring number of a history item
  const getRingNumberForBout = (boutStr: string | number, defaultRing: number = 1): number => {
    if (!boutStr) return defaultRing;
    const s = boutStr.toString().trim().toUpperCase();
    
    // Check if starts with a letter like A01, B01
    const match = s.match(/^([A-Z])(\d+)$/);
    if (match) {
      return match[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1;
    }
    
    // Convert to number
    const num = parseInt(s);
    if (!isNaN(num)) {
      if (num >= 1000) {
        return Math.floor(num / 1000);
      }
    }
    return defaultRing;
  };

  // Filter history by event ID
  const eventHistory = matchHistory.filter(h => h.eventId === currentEventId);

  // Compute stats for each ring
  const ringStats = rings.map(ring => {
    const ringNum = ring.ringNumber;

    // 1. Completed bouts (from history)
    const completedBouts = eventHistory.filter(h => getRingNumberForBout(h.bout) === ringNum);
    const completedCount = completedBouts.length;

    // 2. Currently active bouts on the mat
    const activeBouts: MatchData[] = [];
    if (ring.currentBout) activeBouts.push(ring.currentBout);
    if (ring.onDeck) activeBouts.push(ring.onDeck);
    if (ring.inTheHole) activeBouts.push(ring.inTheHole);
    const activeCount = activeBouts.length;

    // 3. Pending/standby bouts in the queue
    const queuedBouts = boutQueue
      .filter(q => q.data.ring === ringNum && q.data.eventId === currentEventId)
      .map(q => q.data)
      .sort((a, b) => {
        const parseBout = (bout: string | number) => {
          let s = bout.toString().replace(/\s+/g, '').toUpperCase().replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
          if (/^[A-Z]/.test(s)) return s;
          const parsed = parseInt(s.replace(/[^0-9]/g, ''));
          return isNaN(parsed) ? s : parsed;
        };
        const numA = parseBout(a.bout);
        const numB = parseBout(b.bout);
        if (typeof numA === 'number' && typeof numB === 'number') {
          return numA - numB;
        } else if (typeof numA === 'string' && typeof numB === 'string') {
          return numA.localeCompare(numB, undefined, { numeric: true, sensitivity: 'base' });
        } else if (typeof numA === 'number') {
          return -1;
        }
        return 1;
      });
    const queuedCount = queuedBouts.length;

    // Absolute total bouts in system
    const systemTotal = completedCount + activeCount + queuedCount;
    // Bouts left to complete (active + queued)
    const leftCount = activeCount + queuedCount;
    // Percentage complete
    const completionRate = systemTotal > 0 ? Math.round((completedCount / systemTotal) * 100) : 0;

    // Remaining bouts list details
    const allRemaining = [...activeBouts, ...queuedBouts];

    // Estimate time remaining
    const currentMinsPerMatch = ringMins[ringNum] !== undefined ? ringMins[ringNum] : minsPerMatch;
    const estTimeMinutes = leftCount * currentMinsPerMatch;
    const estHours = Math.floor(estTimeMinutes / 60);
    const estMins = estTimeMinutes % 60;
    const formattedTimeLeft = estHours > 0 ? `${estHours}h ${estMins}m` : `${estMins} mins`;

    return {
      ring,
      ringNum,
      ringName: `Ring ${getRingName(ringNum)}`,
      completedCount,
      activeCount,
      queuedCount,
      systemTotal,
      leftCount,
      completionRate,
      allRemaining,
      formattedTimeLeft,
      activeBouts,
      queuedBouts
    };
  });

  // Global aggregates
  const globalTotal = ringStats.reduce((acc, r) => acc + r.systemTotal, 0);
  const globalCompleted = ringStats.reduce((acc, r) => acc + r.completedCount, 0);
  const globalLeft = ringStats.reduce((acc, r) => acc + r.leftCount, 0);
  const globalCompletionRate = globalTotal > 0 ? Math.round((globalCompleted / globalTotal) * 100) : 0;
  
  // Total est minutes remaining aggregated from each individual ring's estimation time per match
  const globalMinutesLeft = ringStats.reduce((acc, r) => {
    const currentMins = ringMins[r.ringNum] !== undefined ? ringMins[r.ringNum] : minsPerMatch;
    return acc + (r.leftCount * currentMins);
  }, 0);
  const globalEstHours = Math.floor(globalMinutesLeft / 60);
  const globalEstMins = globalMinutesLeft % 60;
  const globalTimeLeft = globalEstHours > 0 ? `${globalEstHours}h ${globalEstMins}m` : `${globalEstMins} mins`;

  // Filtered rings to display
  const displayedRingStats = ringStats.filter(r => {
    if (selectedRingFilter !== 'all' && r.ringNum !== selectedRingFilter) return false;
    return true;
  });

  const toggleRingExpanded = (num: number) => {
    setExpandedRing(prev => ({
      ...prev,
      [num]: !prev[num]
    }));
  };

  return (
    <div className="space-y-8" id="ring-summary-container">
      {/* Metrics Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" id="ring-summary-grid">
        {/* Total Matches Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between" id="metric-total-matches">
          <div className="space-y-1">
            <p className="text-[10px] text-slate-500 uppercase font-black tracking-wider">Total Scheduled Bouts</p>
            <p className="text-3xl font-black text-slate-900">{globalTotal}</p>
            <p className="text-xs text-slate-400">Scheduled across all rings</p>
          </div>
          <div className="w-12 h-12 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center">
            <Trophy size={24} />
          </div>
        </div>

        {/* Completed Matches Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between" id="metric-completed">
          <div className="space-y-1">
            <p className="text-[10px] text-slate-500 uppercase font-black tracking-wider">Completed Bouts</p>
            <p className="text-3xl font-black text-emerald-600">{globalCompleted}</p>
            <p className="text-xs text-slate-400">{globalCompletionRate}% total completion rate</p>
          </div>
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center">
            <CheckCircle size={24} />
          </div>
        </div>

        {/* Bouts Left / Left Matches Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between" id="metric-left">
          <div className="space-y-1">
            <p className="text-[10px] text-slate-500 uppercase font-black tracking-wider">Bouts Left to Play</p>
            <p className="text-3xl font-black text-blue-600">{globalLeft}</p>
            <p className="text-xs text-slate-400">Awaiting or currently active</p>
          </div>
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center">
            <TrendingUp size={24} />
          </div>
        </div>

        {/* Estimated Match Time Remaining Card */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between" id="metric-time">
          <div className="space-y-1">
            <p className="text-[10px] text-slate-500 uppercase font-black tracking-wider">Estimated Time Left</p>
            <p className="text-3xl font-black text-amber-600">{globalTimeLeft}</p>
            <p className="text-xs text-slate-400">Aggregated individual ring estimates</p>
          </div>
          <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center">
            <Clock size={24} />
          </div>
        </div>
      </div>

      {/* Control Panel: Customize Estimates and Filters */}
      <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200/60" id="ring-summary-controls">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          {/* Minutes per Match Slider */}
          <div className="flex-1 max-w-md space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-black text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders size={14} className="text-slate-400" />
                Est. Duration per Match
              </label>
              <span className="text-xs font-bold text-slate-900 bg-white border border-slate-200 px-2 py-0.5 rounded-md">
                {minsPerMatch} min / match
              </span>
            </div>
            <input 
              type="range" 
              min="2" 
              max="15" 
              value={minsPerMatch} 
              onChange={(e) => setMinsPerMatch(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-red-600"
            />
            <p className="text-[10px] text-slate-400 leading-none">Increases or decreases time estimates dynamically</p>
          </div>

          {/* Table Filters */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Search Category */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="Filter by category..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-red-500 max-w-xs"
              />
            </div>

            {/* Selector for specific ring */}
            <select
              value={selectedRingFilter}
              onChange={(e) => {
                const val = e.target.value;
                setSelectedRingFilter(val === 'all' ? 'all' : Number(val));
              }}
              className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-black text-slate-600 outline-none focus:ring-2 focus:ring-red-500"
            >
              <option value="all">All Rings</option>
              {rings.map(r => (
                <option key={r.ringNumber} value={r.ringNumber}>Ring {getRingName(r.ringNumber)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Ring-by-Ring Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8" id="ring-cards-summary-display">
        {displayedRingStats.map(({
          ring,
          ringNum,
          ringName,
          completedCount,
          activeCount,
          queuedCount,
          systemTotal,
          leftCount,
          completionRate,
          allRemaining,
          formattedTimeLeft,
          activeBouts,
          queuedBouts
        }) => {
          const isCollapsed = !expandedRing[ringNum];

          // Secondary filtering for detailed checklist based on search query
          const filteredActive = activeBouts.filter(b => 
            searchQuery === '' || b.category.toLowerCase().includes(searchQuery.toLowerCase())
          );
          const filteredQueued = queuedBouts.filter(b => 
            searchQuery === '' || b.category.toLowerCase().includes(searchQuery.toLowerCase())
          );

          return (
            <motion.div 
              layout
              key={ringNum}
              className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden flex flex-col hover:border-slate-300 transition-colors"
              id={`ring-summary-card-${ringNum}`}
            >
              {/* Header Box */}
              <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-slate-900 text-white font-black rounded-2xl flex items-center justify-center text-lg shadow-md">
                    {getRingName(ringNum)}
                  </div>
                  <div>
                    <h3 className="font-extrabold text-slate-800 text-base leading-tight">{ringName} Progress Summary</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
                      {leftCount === 0 ? "🎉 Completed!" : `${leftCount} matches left`}
                    </p>
                  </div>
                </div>

                {/* Status Badges */}
                <div className="flex flex-wrap items-center gap-3">
                  {/* Per Ring Match Duration input */}
                  <div className="flex items-center gap-1.5 bg-white border border-slate-200 shadow-sm px-2.5 py-1 rounded-xl">
                    <Clock size={12} className="text-slate-400 shrink-0" />
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-tight">Per Match:</span>
                    <input 
                      type="number"
                      min="1"
                      max="30"
                      value={ringMins[ringNum] !== undefined ? ringMins[ringNum] : minsPerMatch}
                      onChange={(e) => {
                        const val = Math.max(1, parseInt(e.target.value) || 1);
                        const updated = { ...ringMins, [ringNum]: val };
                        setRingMins(updated);
                        localStorage.setItem('tkd_ring_summary_mins_per_match', JSON.stringify(updated));
                      }}
                      className="w-10 px-1 py-0.5 text-center bg-slate-50 border border-slate-200 rounded-md text-xs font-black text-slate-800 focus:outline-none focus:ring-1 focus:ring-red-500"
                    />
                    <span className="text-[10px] font-bold text-slate-400">m</span>
                  </div>

                  <span className="text-[10px] font-black tracking-widest uppercase bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full border border-slate-200/60 flex items-center gap-1 h-[28px]">
                    Left: {formattedTimeLeft}
                  </span>

                  <button
                    onClick={() => toggleRingExpanded(ringNum)}
                    className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl transition-colors border border-slate-200/40"
                    title={isCollapsed ? "Show details" : "Collapse details"}
                  >
                    {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                  </button>
                </div>
              </div>

              {/* Progress visual section */}
              <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row items-center gap-6">
                {/* Completion Rate Circle & Bar */}
                <div className="w-full md:w-1/3 flex flex-col items-center justify-center py-2 shrink-0">
                  <div className="relative w-24 h-24 flex items-center justify-center">
                    {/* SVG Progress Circle */}
                    <svg className="absolute w-full h-full -rotate-90">
                      <circle
                        cx="48"
                        cy="48"
                        r="40"
                        className="stroke-slate-100 fill-none"
                        strokeWidth="8"
                      />
                      <circle
                        cx="48"
                        cy="48"
                        r="40"
                        className="stroke-red-600 fill-none transition-all duration-1000 ease-out"
                        strokeWidth="8"
                        strokeDasharray={251.2}
                        strokeDashoffset={251.2 - (251.2 * completionRate) / 100}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="text-center">
                      <span className="text-2xl font-black text-slate-900">{completionRate}%</span>
                      <p className="text-[8px] text-slate-400 font-black uppercase tracking-wider">Done</p>
                    </div>
                  </div>
                </div>

                {/* Breakdown and Metrics */}
                <div className="flex-1 w-full grid grid-cols-3 gap-2">
                  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-center">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">Completed</p>
                    <p className="text-lg font-black text-emerald-600">{completedCount}</p>
                    <p className="text-[9px] text-slate-400">Finished bouts</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-center border-l border-slate-200/40">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">On Mats</p>
                    <p className="text-lg font-black text-blue-600">{activeCount}</p>
                    <p className="text-[9px] text-slate-400">Current active</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-center border-l border-slate-200/40">
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1">In Queue</p>
                    <p className="text-lg font-black text-amber-600">{queuedCount}</p>
                    <p className="text-[9px] text-slate-400">Waiting bouts</p>
                  </div>
                </div>
              </div>

              {/* Mat current stats preview */}
              {completedCount === systemTotal ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-400 space-y-2 bg-emerald-50/10">
                  <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center">
                    <CheckCircle size={20} />
                  </div>
                  <div>
                    <h4 className="font-extrabold text-slate-800 text-sm">All Matches Finished</h4>
                    <p className="text-[11px] text-slate-500">Ring {getRingName(ringNum)} is completely clear for this session!</p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 overflow-hidden flex flex-col">
                  {/* Minimized Quick Status Banner */}
                  {isCollapsed && (
                    <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-600">Currently playing:</span>
                        {ring.currentBout ? (
                          <span className="font-black text-red-600 uppercase">
                            Bout {formatBoutNumber(ringNum, ring.currentBout.bout, boutNumberingMode)}
                          </span>
                        ) : (
                          <span className="italic text-slate-400">No active match</span>
                        )}
                      </div>
                      <button 
                        onClick={() => toggleRingExpanded(ringNum)}
                        className="text-[10px] font-black text-red-600 uppercase tracking-widest hover:underline"
                      >
                        View list ({leftCount} remaining)
                      </button>
                    </div>
                  )}

                  {/* Expanded Detail View */}
                  <AnimatePresence>
                    {!isCollapsed && (
                      <motion.div 
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="p-6 space-y-4 max-h-[350px] overflow-y-auto divide-y divide-slate-100">
                          {/* Active Matches Section */}
                          {filteredActive.length > 0 && (
                            <div className="pb-3 space-y-2">
                              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                                <Play size={10} className="fill-blue-600 stroke-blue-600" />
                                On Mat (Active Pool)
                              </h4>
                              <div className="space-y-2">
                                {activeBouts.map((bout, idx) => {
                                  const label = idx === 0 ? "Playing" : (idx === 1 ? "On Deck" : "In Hole");
                                  const labelColor = idx === 0 ? "bg-red-50 text-red-600 border-red-100" : (idx === 1 ? "bg-blue-50 text-blue-600 border-blue-100" : "bg-amber-50 text-amber-600 border-amber-100");
                                  return (
                                    <div key={idx} className="bg-slate-50 p-3 rounded-xl border border-slate-100 flex items-center justify-between gap-4 text-xs">
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                          <span className="font-black text-slate-700">
                                            Bout {formatBoutNumber(ringNum, bout.bout, boutNumberingMode)}
                                          </span>
                                          <span className="text-slate-300">|</span>
                                          <span className="font-bold text-slate-500 truncate text-[10px] uppercase">
                                            {bout.category}
                                          </span>
                                        </div>
                                        <p className="font-black text-slate-800 text-[11px] truncate flex items-center gap-1.5">
                                          <span className="text-[#00a2e8]">{bout.blue_name || "---"}</span>
                                          <span className="text-slate-400 text-[10px]">vs</span>
                                          <span className="text-[#ed1c24]">{bout.red_name || "---"}</span>
                                        </p>
                                      </div>
                                      <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-md border ${labelColor}`}>
                                        {label}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Standby Queue Matches Section */}
                          <div className="pt-3 space-y-2">
                            <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-1">
                              <FastForward size={12} className="text-slate-400" />
                              Standby Standby Queue ({filteredQueued.length})
                            </h4>
                            {filteredQueued.length === 0 ? (
                              <p className="text-xs text-slate-400 italic">No more matches waiting in standby queue.</p>
                            ) : (
                              <div className="space-y-1.5">
                                {filteredQueued.map((bout, idx) => (
                                  <div key={idx} className="p-2.5 rounded-lg hover:bg-slate-50 flex items-center justify-between gap-4 text-xs transition-colors">
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="font-black text-slate-600">
                                          #{idx + 1}
                                        </span>
                                        <span className="font-black text-slate-800">
                                          Bout {formatBoutNumber(ringNum, bout.bout, boutNumberingMode)}
                                        </span>
                                        <span className="text-slate-300">•</span>
                                        <span className="font-bold text-slate-500 text-[10px] uppercase truncate max-w-[200px]">
                                          {bout.category}
                                        </span>
                                      </div>
                                      <p className="font-medium text-slate-500 text-[10px] truncate mt-0.5">
                                        {bout.blue_name} ({bout.blue_club}) vs {bout.red_name} ({bout.red_club})
                                      </p>
                                    </div>
                                    <span className="text-[8px] font-black uppercase bg-slate-100 border border-slate-200 text-slate-400 px-1.5 py-0.5 rounded">
                                      STANDBY
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
