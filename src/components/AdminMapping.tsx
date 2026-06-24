import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, addDoc, deleteDoc, doc, onSnapshot, query, where, setDoc, serverTimestamp } from 'firebase/firestore';
import { BoutMapping, EventData, MatchHistoryItem } from '../types';
import { Trash2, Plus, Save, Hash, ArrowRight, User, Shield, RefreshCw, Trophy } from 'lucide-react';
import { cn, normalizeBoutNumber, formatBoutNumber, getEventSpreadsheetUrl } from '../lib/utils';
import { handleGlobalQuotaTrigger, isFirestoreQuotaExceeded } from '../App';
import Papa from 'papaparse';

interface AdminMappingProps {
  currentEventId: string | null;
  currentEventName: string;
  categories: string[];
  events: EventData[];
  onSyncMatches?: () => void;
  isSyncingMatches?: boolean;
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  matchHistory: MatchHistoryItem[];
}

export function AdminMapping({ 
  currentEventId, 
  currentEventName, 
  categories, 
  events, 
  onSyncMatches, 
  isSyncingMatches,
  boutNumberingMode = 'alphanumeric',
  matchHistory
}: AdminMappingProps) {
  const [mappings, setMappings] = useState<BoutMapping[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(currentEventId || '');
  const [sourceBout, setSourceBout] = useState('');
  const [nextBout, setNextBout] = useState('');
  const [slot, setSlot] = useState<'Chung' | 'Hong'>('Chung');
  const [categoryName, setCategoryName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingResults, setIsSyncingResults] = useState(false);
  const [isSyncingCategories, setIsSyncingCategories] = useState(false);
  const [fetchedCategories, setFetchedCategories] = useState<string[]>([]);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);

  const RESULTS_SHEET_URL = "https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv";
  const CATEGORIES_SHEET_URL = "https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv&gid=0";

  useEffect(() => {
    if (currentEventId && currentEventId !== selectedEventId) {
      setSelectedEventId(currentEventId);
    }
  }, [currentEventId, selectedEventId]);

  const syncCategoriesFromSheet = async () => {
    setIsSyncingCategories(true);
    try {
      let activeUrl = CATEGORIES_SHEET_URL;
      const event = events.find(e => e.id === selectedEventId);
      const resolvedSpreadsheet = getEventSpreadsheetUrl(event);
      if (resolvedSpreadsheet) {
        activeUrl = resolvedSpreadsheet;
        if (!activeUrl.includes('/export?')) {
          activeUrl = activeUrl.replace(/\/edit.*$/, '') + '/export?format=csv';
        }
      }

      const response = await fetch(activeUrl);
      const csvText = await response.text();
      
      Papa.parse(csvText, {
        complete: (result) => {
          const rows = result.data as string[][];
          // Column E is index 4
          const cats = new Set<string>();
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.length >= 5) {
              const cat = row[4]?.trim();
              if (cat && cat !== 'Category' && cat !== '-') {
                cats.add(cat);
              }
            }
          }
          setFetchedCategories(Array.from(cats).sort());
        },
        skipEmptyLines: true
      });
    } catch (error: any) {
      if (error?.name !== 'TypeError' && !error?.message?.includes('fetch')) {
        console.error("Error syncing categories from sheet:", error);
      }
      setFetchedCategories(categories);
    } finally {
      setIsSyncingCategories(false);
    }
  };

  const syncResultsFromSheet = async () => {
    if (!selectedEventId) return;
    setIsSyncingResults(true);
    try {
      let activeUrl = RESULTS_SHEET_URL;
      const event = events.find(e => e.id === selectedEventId);
      const resolvedSpreadsheet = getEventSpreadsheetUrl(event);
      if (resolvedSpreadsheet) {
        activeUrl = resolvedSpreadsheet;
        if (!activeUrl.includes('/export?')) {
          activeUrl = activeUrl.replace(/\/edit.*$/, '') + '/export?format=csv';
        }
      }

      console.log("Syncing results from:", activeUrl);
      const response = await fetch(activeUrl);
      const csvText = await response.text();
      
      Papa.parse(csvText, {
        complete: async (result) => {
          const rows = result.data as string[][];
          // Column J (index 9) is winner result
          // Column C (index 2) is Match No
          // Column D (index 3) is Category
          
          const newHistory: any[] = [];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.length >= 10) {
              const ringNo = row[2]?.trim();
              const matchNo = row[3]?.trim();
              const category = row[4]?.trim();
              const blueName = row[5]?.trim() || '';
              const blueClub = row[6]?.trim() || '';
              const redName = row[7]?.trim() || '';
              const redClub = row[8]?.trim() || '';
              const winner = row[9]?.trim(); // Column J

              if (matchNo && category && winner && winner !== '-' && winner !== '') {
                const normalizedMatchNo = normalizeBoutNumber(matchNo);
                const winnerTrimmed = winner.trim();
                const normWinner = winnerTrimmed.toLowerCase();
                const normBlue = blueName.toLowerCase();
                const normRed = redName.toLowerCase();
                
                let winnerClub = '';
                if (normWinner === normBlue) winnerClub = blueClub;
                else if (normWinner === normRed) winnerClub = redClub;
                // Try partial match if exact fails
                else if (normBlue && (normBlue.includes(normWinner) || normWinner.includes(normBlue))) winnerClub = blueClub;
                else if (normRed && (normRed.includes(normWinner) || normWinner.includes(normRed))) winnerClub = redClub;

                console.log(`Processing sheet row: Ring ${ringNo}, Bout ${matchNo} (Normalized: ${normalizedMatchNo}), Category ${category}, Winner ${winner}, Club ${winnerClub}`);
                const historyId = `${selectedEventId}_${normalizedMatchNo}`;
                
                const existingItem = matchHistory.find((h) => h.id === historyId);
                const isDifferent = !existingItem || 
                                    existingItem.winner !== winnerTrimmed || 
                                    existingItem.winnerClub !== winnerClub;

                const historyItem = {
                  id: historyId,
                  bout: normalizedMatchNo,
                  category: category,
                  winner: winnerTrimmed,
                  winnerClub: winnerClub,
                  eventId: selectedEventId,
                  syncedAt: isDifferent ? serverTimestamp() : (existingItem?.syncedAt || serverTimestamp())
                };
                
                if (isDifferent && !isFirestoreQuotaExceeded) {
                  try {
                    await setDoc(doc(db, 'matchHistory', historyId), historyItem);
                  } catch (err: any) {
                    console.error("Error saving match history item to Firestore:", err);
                    if (err.code === 'resource-exhausted' || err.message?.toLowerCase().includes('quota')) {
                      handleGlobalQuotaTrigger();
                    }
                  }
                }
                newHistory.push({ id: historyId, ...historyItem });
              }
            }
          }

          if (newHistory.length > 0) {
            console.log("Found results in sheet:", newHistory);
            alert(`Synced ${newHistory.length} winners from sheet.`);
            window.dispatchEvent(new CustomEvent('tkd_sync_history', { detail: newHistory }));
          } else {
            alert("No winners found in sheet.");
          }
        },
        skipEmptyLines: true
      });
    } catch (error: any) {
      if (error?.name !== 'TypeError' && !error?.message?.includes('fetch')) {
        console.error("Error syncing results from sheet:", error);
      } else {
        alert("Failed to sync from Google Sheet. Ensure the sheet is accessible and supports CORS (e.g. published to web).");
      }
    } finally {
      setIsSyncingResults(false);
    }
  };

  useEffect(() => {
    if (!selectedEventId) return;
    syncCategoriesFromSheet();

    const q = query(collection(db, 'event_logic'), where('eventId', '==', selectedEventId));
    let unsubscribe = () => {};

    const handleGlobalQuota = () => {
      unsubscribe();
    };
    window.addEventListener('firestore-quota-exceeded', handleGlobalQuota);

    if (isFirestoreQuotaExceeded) return;
    try {
      unsubscribe = onSnapshot(q, (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as BoutMapping));
        setMappings(data);
      }, (error) => {
        if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
          handleGlobalQuotaTrigger();
          unsubscribe();
        } else if (error.code !== 'permission-denied') {
          console.error("Firestore Admin Mappings Error:", error);
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
  }, [selectedEventId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEventId || !sourceBout || !nextBout || !categoryName) return;

    const event = events.find(ev => ev.id === selectedEventId);
    if (!event) return;

    if (isFirestoreQuotaExceeded) return;
    setIsSaving(true);
    try {
      await addDoc(collection(db, 'event_logic'), {
        eventId: selectedEventId,
        eventName: event.name,
        categoryName,
        sourceBout: normalizeBoutNumber(sourceBout),
        nextBout: normalizeBoutNumber(nextBout),
        slot
      });
      setSourceBout('');
      setNextBout('');
    } catch (error: any) {
      console.error("Error saving mapping:", error);
      if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (isFirestoreQuotaExceeded) return;
    try {
      await deleteDoc(doc(db, 'event_logic', id));
    } catch (error: any) {
      console.error("Error deleting mapping:", error);
      if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }
  };

  const handleDeleteAll = async () => {
    if (isFirestoreQuotaExceeded) return;
    try {
      const promises = mappings.map(m => deleteDoc(doc(db, 'event_logic', m.id)));
      await Promise.all(promises);
      setShowDeleteAllModal(false);
    } catch (error: any) {
      console.error("Error deleting all mappings:", error);
      if (error.code === 'resource-exhausted' || error.message?.toLowerCase().includes('quota')) {
        handleGlobalQuotaTrigger();
      }
    }
  };

  const sortedMappings = [...mappings].sort((a, b) => {
    const parseBout = (bout: string | number) => {
      let s = (bout || '').toString().replace(/\s+/g, '').toUpperCase();
      s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
      if (/^[A-Z]/.test(s)) return s;
      const parsed = parseInt(s.replace(/[^0-9]/g, ''));
      return isNaN(parsed) ? s : parsed;
    };
    const valA = parseBout(a.sourceBout || '');
    const valB = parseBout(b.sourceBout || '');
    if (typeof valA === 'number' && typeof valB === 'number') {
      if (valA !== valB) return valA - valB;
    } else if (typeof valA === 'string' && typeof valB === 'string') {
      if (valA !== valB) return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
    } else if (typeof valA === 'number') return -1;
    else return 1;
    return 0;
  });

  return (
    <div className="space-y-8">
      {showDeleteAllModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl">
            <div className="w-16 h-16 bg-red-100 rounded-2xl flex items-center justify-center mb-6 mx-auto">
              <Trash2 size={32} className="text-red-600" />
            </div>
            <h3 className="text-xl font-black text-center text-slate-900 mb-2">Delete All Mappings</h3>
            <p className="text-slate-500 text-center mb-8">
              Are you sure you want to delete ALL mappings for this event? This action cannot be undone.
            </p>
            <div className="flex gap-4">
              <button 
                onClick={() => setShowDeleteAllModal(false)}
                className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 font-bold rounded-xl hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleDeleteAll}
                className="flex-1 px-6 py-3 bg-red-600 text-white font-bold rounded-xl hover:bg-red-700 transition-colors"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
        <h3 className="text-xl font-bold flex items-center gap-2">
          <Shield size={24} className="text-red-600" />
          Bracket Mapping Logic
        </h3>
        
        <div className="flex justify-end gap-2">
          {onSyncMatches && (
            <button 
              onClick={onSyncMatches}
              disabled={isSyncingMatches}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded-xl transition-colors text-xs uppercase tracking-widest disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(isSyncingMatches && "animate-spin")} />
              {isSyncingMatches ? 'Syncing...' : 'Sync Matches'}
            </button>
          )}
          <button 
            onClick={syncCategoriesFromSheet}
            disabled={isSyncingCategories}
            className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors text-xs uppercase tracking-widest disabled:opacity-50"
          >
            <RefreshCw size={14} className={cn(isSyncingCategories && "animate-spin")} />
            {isSyncingCategories ? 'Syncing Categories...' : 'Sync Categories'}
          </button>
          <button 
            onClick={syncResultsFromSheet}
            disabled={isSyncingResults}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 font-bold rounded-xl transition-colors text-xs uppercase tracking-widest disabled:opacity-50 border border-red-100 shadow-sm"
          >
            {isSyncingResults ? <RefreshCw size={14} className="animate-spin" /> : <Trophy size={14} />}
            {isSyncingResults ? 'Syncing...' : 'Fetch All Winners from Sheet'}
          </button>
        </div>
        
        <form onSubmit={handleSave} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 items-end">
          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Select Event</label>
            <div className="relative">
              <Trophy className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <select 
                value={selectedEventId}
                onChange={(e) => setSelectedEventId(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-red-500"
                required
              >
                <option value="" disabled>Select Event</option>
                {events.map((ev, i) => (
                  <option key={`${ev.id}-${i}`} value={ev.id}>{ev.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Category Name</label>
            <select 
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-red-500"
              required
            >
              <option value="">Select Category</option>
              {(fetchedCategories.length > 0 ? fetchedCategories : categories).map((cat, i) => (
                <option key={`${cat}-${i}`} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          
          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Source Bout #</label>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                value={sourceBout}
                onChange={(e) => setSourceBout(e.target.value)}
                placeholder="e.g. 1001"
                className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-red-500"
                required
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Target Slot</label>
            <select 
              value={slot}
              onChange={(e) => setSlot(e.target.value as 'Chung' | 'Hong')}
              className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-red-500"
              required
            >
              <option value="Chung">Chung (Blue)</option>
              <option value="Hong">Hong (Red)</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Next Bout #</label>
            <div className="relative">
              <ArrowRight className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                value={nextBout}
                onChange={(e) => setNextBout(e.target.value)}
                placeholder="e.g. 1010"
                className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-red-500"
                required
              />
            </div>
          </div>

          <button 
            type="submit"
            disabled={isSaving}
            className="h-[42px] bg-red-600 hover:bg-red-700 text-white rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-lg shadow-red-100 disabled:opacity-50"
          >
            <Save size={16} />
            {isSaving ? 'Saving...' : 'Save Mapping'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
          <h4 className="font-black text-slate-800 uppercase tracking-widest text-xs">Active Advancement Logic</h4>
          {mappings.length > 0 && (
            <button
              onClick={() => setShowDeleteAllModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 font-bold rounded-lg transition-colors text-xs uppercase tracking-widest"
            >
              <Trash2 size={14} />
              Delete All
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50">
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Event</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Category</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Source Bout</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Next Bout</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Slot</th>
                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedMappings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400 text-sm italic">
                    No mappings defined for the selected event yet.
                  </td>
                </tr>
              ) : (
                sortedMappings.map((m, idx) => (
                  <tr key={`${m.id}-${idx}`} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">{m.eventName || 'Unknown'}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-xs font-bold text-slate-700">{m.categoryName}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-slate-100 rounded flex items-center justify-center text-[10px] font-black text-slate-500">
                          #
                        </div>
                        <span className="text-sm font-black text-slate-900">{formatBoutNumber(0, m.sourceBout, boutNumberingMode)}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <ArrowRight size={14} className="text-slate-300" />
                        <span className="text-sm font-black text-slate-900">{formatBoutNumber(0, m.nextBout, boutNumberingMode)}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={cn(
                        "text-[10px] font-black px-2 py-1 rounded uppercase tracking-widest",
                        m.slot === 'Chung' ? "bg-blue-50 text-blue-600" : "bg-red-50 text-red-600"
                      )}>
                        {m.slot}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={() => handleDelete(m.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
