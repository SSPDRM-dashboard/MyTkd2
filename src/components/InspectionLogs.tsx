import React, { useState } from 'react';
import { MatchData, RingStatus, MatchHistoryItem } from '../types';
import { Search, CheckCircle2, XCircle } from 'lucide-react';
import { cn, formatBoutNumber } from '../lib/utils';
import { INSPECTION_ITEMS, POOMSAE_INSPECTION_ITEMS } from './TASheet';

interface InspectionLogsProps {
  boutQueue: { id: string, data: MatchData }[];
  rings: RingStatus[];
  matchHistory: MatchHistoryItem[];
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  currentEventId?: string | null;
}

export function InspectionLogs({ boutQueue, rings, matchHistory, boutNumberingMode = 'alphanumeric', currentEventId }: InspectionLogsProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Collect matches from queue and rings
  const allMatchesMap = new Map<string, MatchData>();
  
  // 1. Queue
  boutQueue.forEach(q => allMatchesMap.set(q.data.bout.toString(), q.data));
  
  // 2. Rings
  rings.forEach(ring => {
    if (ring.currentBout) allMatchesMap.set(ring.currentBout.bout.toString(), ring.currentBout);
    if (ring.onDeck) allMatchesMap.set(ring.onDeck.bout.toString(), ring.onDeck);
    if (ring.inTheHole) allMatchesMap.set(ring.inTheHole.bout.toString(), ring.inTheHole);
  });

  // Filter matches that have at least one inspection
  const inspectedMatches = Array.from(allMatchesMap.values())
    .filter(m => (!currentEventId || m.eventId === currentEventId))
    .filter(m => m.blue_inspected || m.red_inspected)
    .filter(m => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        m.bout.toString().toLowerCase().includes(q) ||
        m.blue_name.toLowerCase().includes(q) ||
        m.red_name.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (a.inspectedAt && b.inspectedAt) return b.inspectedAt - a.inspectedAt;
      if (a.inspectedAt) return -1;
      if (b.inspectedAt) return 1;

      const numA = parseInt(a.bout.toString().replace(/[^0-9]/g, '')) || 0;
      const numB = parseInt(b.bout.toString().replace(/[^0-9]/g, '')) || 0;
      return numB - numA; // Newest first
    });

  const renderChecklist = (checklist?: string[], isPoomsae?: boolean) => {
    if (!checklist || checklist.length === 0) return <p className="text-xs text-slate-400 italic">No checklist data</p>;
    
    // Fallback to standard if we don't know it's poomsae, or use specific list if passed
    const itemsList = isPoomsae ? POOMSAE_INSPECTION_ITEMS : INSPECTION_ITEMS;
    
    return (
      <div className="space-y-4 mt-4">
        {itemsList.map((section, idx) => {
          return (
            <div key={idx}>
              <h5 className="text-[10px] font-black uppercase text-slate-500 mb-2">{section.category}</h5>
              <ul className="space-y-1">
                {section.items.map(item => {
                  const isChecked = checklist.includes(item.id);
                  return (
                    <li key={item.id} className={cn("flex items-start gap-2 text-xs", isChecked ? "text-slate-700" : "text-slate-400 opacity-60")}>
                      {isChecked ? (
                        <CheckCircle2 size={14} className="text-green-500 shrink-0 mt-0.5" />
                      ) : (
                        <XCircle size={14} className="text-slate-300 shrink-0 mt-0.5" />
                      )}
                      <span>{item.label}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h3 className="text-2xl font-black text-slate-800 uppercase tracking-tight">Inspection Logs</h3>
          <p className="text-slate-500 font-medium">Review player signatures and equipment checklists</p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input 
            type="text"
            placeholder="Search match or player..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold w-64 focus:ring-2 focus:ring-blue-500 outline-none transition-all"
          />
        </div>
      </div>

      {inspectedMatches.length === 0 ? (
        <div className="py-12 text-center bg-slate-50 rounded-2xl border border-slate-100">
          <p className="text-slate-500 font-bold">No inspection logs found.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {inspectedMatches.map((match, idx) => (
            <div key={`${match.ring}-${match.bout}-${idx}`} className="border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
              <div className="bg-slate-50 px-6 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="px-3 py-1 bg-slate-800 text-white rounded-lg text-xs font-black uppercase tracking-widest">
                    Ring {match.ring}
                  </span>
                  <span className="text-lg font-black text-slate-800">Match {formatBoutNumber(match.ring, match.bout, boutNumberingMode)}</span>
                </div>
                <span className="text-sm font-bold text-slate-500 uppercase">{match.category}</span>
              </div>
              
              <div className={cn(
                "grid divide-y md:divide-y-0 divide-slate-200",
                match.red_name ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
              )}>
                {/* Blue Player */}
                <div className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h4 className="text-lg font-black text-[#00a2e8] uppercase">{match.blue_name}</h4>
                      <p className="text-xs font-bold text-yellow-200 uppercase">{match.blue_club}</p>
                    </div>
                    {match.blue_inspected ? (
                      <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-[10px] font-black uppercase tracking-widest flex items-center gap-1">
                        <CheckCircle2 size={12} /> Inspected
                      </span>
                    ) : (
                      <span className="px-2 py-1 bg-slate-100 text-slate-500 rounded text-[10px] font-black uppercase tracking-widest flex items-center gap-1">
                        <XCircle size={12} /> Pending
                      </span>
                    )}
                  </div>
                  
                  {match.blue_signature && (
                    <div className="mb-6">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Signature</p>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-2 h-32 flex items-center justify-center">
                        <img src={match.blue_signature} alt="Blue Signature" className="max-h-full max-w-full object-contain mix-blend-multiply" />
                      </div>
                    </div>
                  )}
                  
                  <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Checklist Items</p>
                    {renderChecklist(match.blue_checklist, match.category?.toUpperCase().includes('POOMSAE') || match.category?.toUpperCase().includes('FREESTYLE'))}
                  </div>
                </div>

                {/* Red Player - Only shown if there is a red player (not a solo poomsae) */}
                {match.red_name && (
                  <div className="p-6 border-t md:border-t-0 md:border-l border-slate-200">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h4 className="text-lg font-black text-[#ed1c24] uppercase">{match.red_name}</h4>
                        <p className="text-xs font-bold text-yellow-200 uppercase">{match.red_club}</p>
                      </div>
                      {match.red_inspected ? (
                        <span className="px-2 py-1 bg-green-100 text-green-700 rounded text-[10px] font-black uppercase tracking-widest flex items-center gap-1">
                          <CheckCircle2 size={12} /> Inspected
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-slate-100 text-slate-500 rounded text-[10px] font-black uppercase tracking-widest flex items-center gap-1">
                          <XCircle size={12} /> Pending
                        </span>
                      )}
                    </div>
                    
                    {match.red_signature && (
                      <div className="mb-6">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Signature</p>
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-2 h-32 flex items-center justify-center">
                          <img src={match.red_signature} alt="Red Signature" className="max-h-full max-w-full object-contain mix-blend-multiply" />
                        </div>
                      </div>
                    )}
                    
                    <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Checklist Items</p>
                      {renderChecklist(match.red_checklist, match.category?.toUpperCase().includes('POOMSAE') || match.category?.toUpperCase().includes('FREESTYLE'))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
