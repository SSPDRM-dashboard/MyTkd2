import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Edit2, X } from 'lucide-react';
import { RingStatus, MatchData, EventData } from '../types';
import { cn, normalizeBoutNumber, formatBoutNumber, isBoutMatch } from '../lib/utils';

interface EditBoutDetailsModalProps {
  onClose: () => void;
  onSubmit: (ringNumber: number, boutNumber: string, updates: Partial<MatchData>) => void;
  rings: RingStatus[];
  queue: { id: string; data: MatchData }[];
  user: any;
  boutNumberingMode: 'numeric' | 'alphanumeric';
  events: EventData[];
  currentEventId: string | null;
}

export function EditBoutDetailsModal({ onClose, onSubmit, rings, queue, user, boutNumberingMode, events, currentEventId }: EditBoutDetailsModalProps) {
  const defaultRing = (user?.role === 'admin' || sessionStorage.getItem('user_role') === 'court_clerk' || user?.role === 'user') ? (rings[0]?.ringNumber || 1) : (Number(user?.assignedRing) || 1);
  
  const [formData, setFormData] = useState({
    eventId: currentEventId || '',
    ring: defaultRing,
    bout: '',
    blue_name: '',
    blue_club: '',
    red_name: '',
    red_club: '',
    category: '',
    is_poomsae_solo: false
  });

  const availableRings = (user?.role === 'admin' || sessionStorage.getItem('user_role') === 'court_clerk' || user?.role === 'user') 
    ? rings 
    : rings.filter(r => Number(r.ringNumber) === Number(user?.assignedRing));

  const displayRings = availableRings.length > 0 
    ? availableRings 
    : (user?.assignedRing ? [{ ringNumber: Number(user.assignedRing) } as RingStatus] : rings);

  const lastLookupRef = React.useRef<{ ring: number; bout: string; eventId: string } | null>(null);

  // Auto-fill details when bout number changes
  useEffect(() => {
    if (!formData.bout) {
      lastLookupRef.current = null;
      return;
    }
    
    const normalizedBout = normalizeBoutNumber(formData.bout);
    const lookupKey = {
      ring: formData.ring,
      bout: normalizedBout,
      eventId: formData.eventId
    };

    // If we've already synced/auto-filled for this combination, don't overwrite user changes
    if (
      lastLookupRef.current &&
      lastLookupRef.current.ring === lookupKey.ring &&
      lastLookupRef.current.bout === lookupKey.bout &&
      lastLookupRef.current.eventId === lookupKey.eventId
    ) {
      return;
    }
    
    // Check active bout
    const ring = rings.find(r => r.ringNumber === formData.ring);
    
    let foundMatch: MatchData | null = null;
    if (ring?.currentBout && isBoutMatch(ring.currentBout.bout, formData.bout) && (ring.currentBout.eventId === formData.eventId || !formData.eventId)) {
      foundMatch = ring.currentBout;
    } else if (ring?.onDeck && isBoutMatch(ring.onDeck.bout, formData.bout) && (ring.onDeck.eventId === formData.eventId || !formData.eventId)) {
      foundMatch = ring.onDeck;
    } else if (ring?.inTheHole && isBoutMatch(ring.inTheHole.bout, formData.bout) && (ring.inTheHole.eventId === formData.eventId || !formData.eventId)) {
      foundMatch = ring.inTheHole;
    }

    if (foundMatch) {
      const isSolo = foundMatch.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || false;
      lastLookupRef.current = lookupKey;
      setFormData(prev => ({
        ...prev,
        blue_name: foundMatch!.blue_name || '',
        blue_club: foundMatch!.blue_club || '',
        red_name: foundMatch!.red_name || '',
        red_club: foundMatch!.red_club || '',
        category: foundMatch!.category || '',
        is_poomsae_solo: isSolo
      }));
      return;
    }

    // Check queue
    const queuedBout = queue.find(q => q.data.ring === formData.ring && isBoutMatch(q.data.bout, formData.bout) && (q.data.eventId === formData.eventId || !formData.eventId));
    if (queuedBout) {
      const isSolo = queuedBout.data.category?.toUpperCase().includes('INDIVIDUAL POOMSAE') || false;
      lastLookupRef.current = lookupKey;
      setFormData(prev => ({
        ...prev,
        blue_name: queuedBout.data.blue_name || '',
        blue_club: queuedBout.data.blue_club || '',
        red_name: queuedBout.data.red_name || '',
        red_club: queuedBout.data.red_club || '',
        category: queuedBout.data.category || '',
        is_poomsae_solo: isSolo
      }));
    }
  }, [formData.ring, formData.bout, formData.eventId, rings, queue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.bout) return;
    
    let updatedCategory = formData.category;
    if (formData.is_poomsae_solo && !updatedCategory.toUpperCase().includes('INDIVIDUAL POOMSAE')) {
      updatedCategory = updatedCategory ? `${updatedCategory} (INDIVIDUAL POOMSAE)` : 'INDIVIDUAL POOMSAE';
    } else if (!formData.is_poomsae_solo && updatedCategory.toUpperCase().includes('INDIVIDUAL POOMSAE')) {
      updatedCategory = updatedCategory.replace(/\s*\(INDIVIDUAL POOMSAE\)/gi, '').replace(/INDIVIDUAL POOMSAE/gi, '').trim();
    }

    onSubmit(formData.ring, formData.bout, {
      blue_name: formData.blue_name,
      blue_club: formData.blue_club,
      red_name: formData.is_poomsae_solo ? '' : formData.red_name,
      red_club: formData.is_poomsae_solo ? '' : formData.red_club,
      category: updatedCategory,
      isManuallyEdited: true
    });
    onClose();
  };

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
              <h2 className="text-lg font-black tracking-tight">Edit Bout Details</h2>
              <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Update Names & Clubs</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
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
                value={formData.bout || ''}
                onChange={(e) => setFormData({...formData, bout: e.target.value.toUpperCase()})}
                onBlur={() => {
                  if (formData.bout) {
                    setFormData(prev => ({
                      ...prev,
                      bout: formatBoutNumber(formData.ring, formData.bout, boutNumberingMode)
                    }));
                  }
                }}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
                placeholder={boutNumberingMode === 'alphanumeric' ? "e.g. A01" : "e.g. 1001"}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Category</label>
            <input 
              type="text" 
              value={formData.category || ''}
              onChange={(e) => setFormData({...formData, category: e.target.value})}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold"
              placeholder="e.g. U30 Female Individual"
            />
          </div>

          <div className="flex items-center justify-between p-4 bg-slate-50 border border-slate-100 rounded-xl">
            <div>
              <p className="text-xs font-black text-slate-700 uppercase tracking-widest leading-none mb-1">Individual Poomsae Mode</p>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">One player per performance</p>
            </div>
            <button
              type="button"
              onClick={() => setFormData(prev => ({ ...prev, is_poomsae_solo: !prev.is_poomsae_solo }))}
              className={cn(
                "w-12 h-6 rounded-full transition-all relative",
                formData.is_poomsae_solo ? "bg-blue-600" : "bg-slate-300"
              )}
            >
              <div className={cn(
                "w-4 h-4 bg-white rounded-full absolute top-1 transition-all",
                formData.is_poomsae_solo ? "left-7" : "left-1"
              )} />
            </button>
          </div>

          <div className="space-y-4">
            <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl space-y-4">
              <h3 className="text-xs font-black text-blue-800 uppercase tracking-widest">{formData.is_poomsae_solo ? 'Performer' : 'Blue Corner'}</h3>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-blue-600 uppercase tracking-widest ml-1">Name</label>
                <input 
                  type="text" 
                  value={formData.blue_name || ''}
                  onChange={(e) => setFormData({...formData, blue_name: e.target.value})}
                  className="w-full px-4 py-2 bg-white border border-blue-200 rounded-lg text-sm font-bold"
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-blue-600 uppercase tracking-widest ml-1">Club</label>
                <input 
                  type="text" 
                  value={formData.blue_club || ''}
                  onChange={(e) => setFormData({...formData, blue_club: e.target.value})}
                  className="w-full px-4 py-2 bg-white border border-blue-200 rounded-lg text-sm font-bold"
                  required
                />
              </div>
            </div>

            {!formData.is_poomsae_solo && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-xl space-y-4">
                <h3 className="text-xs font-black text-red-800 uppercase tracking-widest">Red Corner</h3>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-red-600 uppercase tracking-widest ml-1">Name</label>
                  <input 
                    type="text" 
                    value={formData.red_name || ''}
                    onChange={(e) => setFormData({...formData, red_name: e.target.value})}
                    className="w-full px-4 py-2 bg-white border border-red-200 rounded-lg text-sm font-bold"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-red-600 uppercase tracking-widest ml-1">Club</label>
                  <input 
                    type="text" 
                    value={formData.red_club || ''}
                    onChange={(e) => setFormData({...formData, red_club: e.target.value})}
                    className="w-full px-4 py-2 bg-white border border-red-200 rounded-lg text-sm font-bold"
                    required
                  />
                </div>
              </div>
            )}
          </div>

          <button 
            type="submit"
            className="w-full py-4 bg-slate-900 hover:bg-slate-800 text-white rounded-xl font-black uppercase tracking-widest text-sm transition-all shadow-lg shadow-slate-200"
          >
            Update Details
          </button>
        </form>
      </motion.div>
    </div>
  );
}
