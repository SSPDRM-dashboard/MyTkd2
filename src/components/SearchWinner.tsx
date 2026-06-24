import React, { useState } from 'react';
import { Search, Trophy, RotateCcw, AlertTriangle } from 'lucide-react';
import { MatchHistoryItem } from '../types';
import { isBoutMatch } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

interface SearchWinnerProps {
  matchHistory: MatchHistoryItem[];
  currentEventId: string | null;
  onRestoreMatch?: (match: MatchHistoryItem) => void;
}

export function SearchWinner({ matchHistory, currentEventId, onRestoreMatch }: SearchWinnerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [result, setResult] = useState<MatchHistoryItem | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !currentEventId) return;

    const query = searchQuery.trim();
    const found = matchHistory.find(h => 
      h.eventId === currentEventId && isBoutMatch(h.bout, query)
    );

    setResult(found || null);
    setHasSearched(true);
    setIsConfirming(false);
    setShowSuccess(false);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="text-xl font-bold flex items-center gap-2 mb-6">
          <Search size={24} className="text-slate-400" />
          Search Winner
        </h2>

        <form onSubmit={handleSearch} className="flex gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={20} />
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Enter Match No (e.g. A1, 23)"
              className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-lg font-bold text-slate-700 outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
            />
          </div>
          <button 
            type="submit"
            className="px-6 py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition-colors shadow-sm flex items-center gap-2"
          >
            Search
          </button>
        </form>
      </div>

      <AnimatePresence mode="wait">
        {hasSearched && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 text-center"
          >
            {result ? (
              <div className="space-y-6">
                <div>
                  <p className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-1">Match No</p>
                  <p className="text-2xl font-black text-slate-900">{result.bout}</p>
                </div>
                {result.category && (
                  <div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Category</p>
                    <p className="text-sm font-bold text-slate-700">{result.category}</p>
                  </div>
                )}
                <div className="pt-6 border-t border-slate-100 flex flex-col items-center">
                  <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mb-4 text-yellow-600">
                    <Trophy size={32} />
                  </div>
                  <p className="text-[10px] font-black text-yellow-600 uppercase tracking-widest mb-1">Winner</p>
                  <p className="text-3xl font-black text-slate-900 mb-2 uppercase">{result.winner}</p>
                  <p className="text-lg font-bold text-yellow-200 uppercase">{result.winnerClub || 'UNKNOWN CLUB'}</p>
                </div>
                {onRestoreMatch && !showSuccess && (
                  <div className="pt-6 border-t border-slate-100">
                    {!isConfirming ? (
                      <button
                        onClick={() => setIsConfirming(true)}
                        className="px-6 py-2.5 bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 font-bold rounded-xl transition-colors flex items-center justify-center gap-2 mx-auto"
                      >
                        <RotateCcw size={18} />
                        Restore Match to Queue
                      </button>
                    ) : (
                      <div className="bg-red-50 p-4 rounded-xl space-y-4">
                        <div className="flex items-center gap-2 text-red-700 font-bold justify-center">
                          <AlertTriangle size={20} />
                          <p>Are you sure?</p>
                        </div>
                        <p className="text-sm text-red-600 text-center">This will remove the recorded winner and place Bout {result.bout} back into the active queue.</p>
                        <div className="flex items-center justify-center gap-3">
                          <button
                            onClick={() => setIsConfirming(false)}
                            className="px-4 py-2 bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 font-bold rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => {
                              onRestoreMatch(result);
                              setShowSuccess(true);
                              setTimeout(() => {
                                setResult(null);
                                setHasSearched(false);
                                setShowSuccess(false);
                              }, 2500);
                            }}
                            className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 font-bold rounded-lg transition-colors"
                          >
                            Yes, Restore Bout
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {showSuccess && (
                  <div className="pt-6 border-t border-slate-100">
                    <div className="bg-green-50 p-4 rounded-xl text-center">
                      <p className="text-green-700 font-bold">Bout {result.bout} restored successfully!</p>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-12">
                <p className="text-lg font-bold text-slate-500 mb-2">No Winner Found</p>
                <p className="text-sm text-slate-400">We couldn't find a recorded winner for Match "{searchQuery}" in the current event.</p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
