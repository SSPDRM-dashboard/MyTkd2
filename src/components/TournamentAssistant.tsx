import React, { useState, useEffect, useRef } from 'react';
import { 
  MessageSquare, 
  Send, 
  X, 
  Bot, 
  User, 
  Loader2, 
  Sparkles,
  ChevronDown,
  ChevronUp,
  Trophy,
  Users,
  LayoutDashboard
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { cn, formatBoutNumber } from '../lib/utils';
import { MatchData, EventData, RingStatus } from '../types';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface TournamentAssistantProps {
  currentEventId: string | null;
  events: EventData[];
  rings: RingStatus[];
  boutQueue: { id: string, data: MatchData }[];
  athletes: any[];
  boutNumberingMode: 'numeric' | 'alphanumeric';
}

export function TournamentAssistant({ 
  currentEventId, 
  events, 
  rings, 
  boutQueue, 
  athletes,
  boutNumberingMode
}: TournamentAssistantProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('tkd_assistant_messages');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      } catch (e) {
        return [];
      }
    }
    return [
      {
        role: 'assistant',
        content: "Hello! I'm your Tournament Assistant. I can help you manage your event, answer questions about athletes, or help with bracket logic. How can I help you today?",
        timestamp: new Date()
      }
    ];
  });
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('tkd_assistant_messages', JSON.stringify(messages));
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const apiKey = import.meta.env.VITE_CUSTOM_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || process.env.CUSTOM_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("No API Key found. When deploying to Vercel, make sure to add VITE_GEMINI_API_KEY or VITE_CUSTOM_API_KEY to your environment variables.");
      }
      console.log("Using API Key starting with:", apiKey.substring(0, 5), "Is Custom?", !!import.meta.env.VITE_CUSTOM_API_KEY);

      const ai = new GoogleGenAI({ apiKey });
      const currentEvent = events.find(e => e.id === currentEventId);
      
      // Prepare context about the tournament
      const context = `
        You are a helpful Taekwondo Tournament Assistant for the "MY-TKD" system.
        Current Event: ${currentEvent?.name || 'None selected'}
        Event Date: ${currentEvent?.eventDate || 'N/A'}
        Total Rings: ${rings.length}
        Total Bouts in Queue: ${boutQueue.length}
        Total Athletes: ${athletes.length}
        
        Active Rings Status:
        ${rings.map(r => `Ring ${r.ringNumber}: ${r.currentBout ? `Bout ${formatBoutNumber(r.ringNumber, r.currentBout.bout, boutNumberingMode)} (${r.currentBout.category})` : 'Idle'}`).join('\n')}
        
        Recent Bouts in Queue:
        ${boutQueue.slice(0, 10).map(b => `Bout ${formatBoutNumber(b.data.ring, b.data.bout, boutNumberingMode)}: ${b.data.blue_name} vs ${b.data.red_name} (${b.data.category})`).join('\n')}
        
        Instructions:
        - Be concise and professional.
        - Help with tournament management logic.
        - If asked about specific athletes or bouts, use the provided context.
        - You can suggest announcements or help with bracket advancement rules.
        - If you don't know something, say so.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          { role: 'user', parts: [{ text: context }] },
          ...messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          { role: 'user', parts: [{ text: input }] }
        ],
        config: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
        }
      });

      const assistantMessage: Message = {
        role: 'assistant',
        content: response.text || "I'm sorry, I couldn't generate a response.",
        timestamp: new Date()
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error("Assistant Error:", error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${error.message || "Something went wrong. Please check your API key."}`,
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-[100] print:hidden">
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            exit={{ scale: 0, rotate: 20 }}
            onClick={() => setIsOpen(true)}
            className="w-14 h-14 bg-red-600 text-white rounded-full shadow-2xl flex items-center justify-center hover:bg-red-700 transition-all hover:scale-110 group relative"
          >
            <Bot size={28} className="group-hover:animate-bounce" />
            <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white animate-pulse" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ 
              opacity: 1, 
              y: 0, 
              scale: 1,
              height: isMinimized ? '80px' : '500px'
            }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="w-80 md:w-96 bg-white rounded-3xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="p-4 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
                  <Bot size={20} />
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-tight">Tournament AI</h3>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Online</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => setIsMinimized(!isMinimized)}
                  className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                >
                  {isMinimized ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                <button 
                  onClick={() => setIsOpen(false)}
                  className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {!isMinimized && (
              <>
                {/* Messages */}
                <div 
                  ref={scrollRef}
                  className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50"
                >
                  {messages.map((m, i) => (
                    <div 
                      key={i} 
                      className={cn(
                        "flex gap-3 max-w-[85%]",
                        m.role === 'user' ? "ml-auto flex-row-reverse" : ""
                      )}
                    >
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
                        m.role === 'assistant' ? "bg-red-100 text-red-600" : "bg-slate-200 text-slate-600"
                      )}>
                        {m.role === 'assistant' ? <Bot size={16} /> : <User size={16} />}
                      </div>
                      <div className={cn(
                        "p-3 rounded-2xl text-sm leading-relaxed",
                        m.role === 'assistant' 
                          ? "bg-white border border-slate-100 text-slate-700 shadow-sm" 
                          : "bg-red-600 text-white font-medium"
                      )}>
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {isLoading && (
                    <div className="flex gap-3">
                      <div className="w-8 h-8 bg-red-100 text-red-600 rounded-lg flex items-center justify-center">
                        <Loader2 size={16} className="animate-spin" />
                      </div>
                      <div className="bg-white border border-slate-100 p-3 rounded-2xl shadow-sm">
                        <div className="flex gap-1">
                          <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" />
                          <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.2s]" />
                          <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.4s]" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Input */}
                <div className="p-4 bg-white border-t border-slate-100">
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                      placeholder="Ask me anything..."
                      className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-red-500 transition-all"
                    />
                    <button 
                      onClick={handleSend}
                      disabled={!input.trim() || isLoading}
                      className="w-10 h-10 bg-red-600 text-white rounded-xl flex items-center justify-center hover:bg-red-700 transition-all disabled:opacity-50 disabled:hover:scale-100 hover:scale-105 active:scale-95"
                    >
                      <Send size={18} />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-4">
                    <button 
                      onClick={() => setInput("How many athletes are registered?")}
                      className="text-[9px] font-black text-slate-400 uppercase tracking-widest hover:text-red-600 transition-colors"
                    >
                      Athletes Count
                    </button>
                    <button 
                      onClick={() => setInput("Suggest an announcement for the next bout.")}
                      className="text-[9px] font-black text-slate-400 uppercase tracking-widest hover:text-red-600 transition-colors"
                    >
                      Announcements
                    </button>
                    <button 
                      onClick={() => setMessages([])}
                      className="text-[9px] font-black text-slate-400 uppercase tracking-widest hover:text-red-600 transition-colors"
                    >
                      Clear Chat
                    </button>
                  </div>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
