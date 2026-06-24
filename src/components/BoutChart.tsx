import React, { useState, useMemo } from 'react';
import { BoutMapping, MatchData, MatchHistoryItem } from '../types';
import { formatBoutNumber, normalizeBoutNumber, getBoutNumber, parseRingNumber } from '../lib/utils';
import { Layers } from 'lucide-react';

export interface BoutChartProps {
  mappings: BoutMapping[];
  boutQueue: {id: string, data: MatchData}[];
  matchHistory: MatchHistoryItem[];
  boutNumberingMode?: 'numeric' | 'alphanumeric';
  onUpdateBoutNumber?: (oldBoutId: string, newBoutId: string) => void;
  onUpdateBoutName?: (boutId: string, color: 'blue' | 'red', newName: string) => void;
}

interface BracketNode {
  id: string; // The bout number
  match: MatchData | MatchHistoryItem | null;
  sources: { sourceId: string; slot: 'Chung' | 'Hong' }[];
  target: string | null;
  depth: number;
  x: number;
  y: number;
}

export function BoutChart({ mappings, boutQueue, matchHistory, boutNumberingMode = 'alphanumeric', onUpdateBoutNumber, onUpdateBoutName }: BoutChartProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [editingNameNodeId, setEditingNameNodeId] = useState<string | null>(null);
  const [editingNameColor, setEditingNameColor] = useState<'blue' | 'red' | null>(null);
  const [editNameValue, setEditNameValue] = useState<string>('');

  const categories = useMemo(() => {
    const cats = new Set<string>();
    mappings.forEach(m => {
      if (m.categoryName) cats.add(m.categoryName.trim());
    });
    return Array.from(cats).filter(Boolean).sort();
  }, [mappings]);

  const { nodes, edges, width, height } = useMemo(() => {
    if (!selectedCategory) return { nodes: [], edges: [], width: 0, height: 0 };

    const catMappings = mappings.filter(m => m.categoryName?.trim() === selectedCategory);
    
    // Collect all unique bouts
    const boutIds = new Set<string>();
    catMappings.forEach(m => {
      if (m.sourceBout) boutIds.add(normalizeBoutNumber(m.sourceBout));
      if (m.nextBout) boutIds.add(normalizeBoutNumber(m.nextBout));
    });

    // We also want to include any bouts from the bout queue / match history that match this category
    // even if they don't have mappings (maybe it's a finals only category)
    const allMatches = [...boutQueue.map(q => q.data), ...matchHistory];
    const catMatches = allMatches.filter(m => m.category?.trim() === selectedCategory);
    catMatches.forEach(m => {
       boutIds.add(normalizeBoutNumber(m.bout.toString()));
    });

    const nodeMap = new Map<string, BracketNode>();
    boutIds.forEach(id => {
      // Find match data
      const match = catMatches.find(m => normalizeBoutNumber(m.bout.toString()) === id) || null;
      nodeMap.set(id, { id, match, sources: [], target: null, depth: 0, x: 0, y: 0 });
    });

    catMappings.forEach(m => {
      const sourceId = normalizeBoutNumber(m.sourceBout);
      const nextId = normalizeBoutNumber(m.nextBout);
      if (nodeMap.has(sourceId) && nodeMap.has(nextId)) {
        nodeMap.get(sourceId)!.target = nextId;
        nodeMap.get(nextId)!.sources.push({ sourceId, slot: m.slot });
      }
    });

    // Calculate depths from root backwards (right-to-left) to line up columns perfectly regardless of byes.
    const nodesArray = Array.from(nodeMap.values());
    const nodeIds = nodesArray.map(n => n.id);
    
    // Initialize levelFromRoot of all nodes to -1
    const levelMap = new Map<string, number>();
    nodeIds.forEach(id => levelMap.set(id, -1));

    // Identify the root nodes (target is null or not in nodeMap)
    const roots = nodesArray.filter(n => n.target === null || !nodeMap.has(n.target));
    roots.forEach(r => levelMap.set(r.id, 0));

    // Iteratively propagate levels from target to sources backwards
    let levelChanged = true;
    while (levelChanged) {
      levelChanged = false;
      nodesArray.forEach(node => {
        const currentLevel = levelMap.get(node.id) || 0;
        if (currentLevel !== -1) {
          node.sources.forEach(source => {
            const sourceNode = nodeMap.get(source.sourceId);
            if (sourceNode) {
              const oldLevel = levelMap.get(sourceNode.id) || -1;
              const newLevel = currentLevel + 1;
              if (newLevel > oldLevel) {
                levelMap.set(sourceNode.id, newLevel);
                levelChanged = true;
              }
            }
          });
        }
      });
    }

    // Find the maximum level to determine total columns needed
    const maxLevel = Math.max(0, ...Array.from(levelMap.values()));

    // Assign depths based on columns from left (depth 0) to right (depth = maxLevel)
    nodesArray.forEach(node => {
      const level = levelMap.get(node.id);
      if (level !== undefined && level !== -1) {
        node.depth = maxLevel - level;
      } else {
        node.depth = 0; // Fallback for orphans
      }
    });

    // Partition nodes by depth for layout tracking
    const nodesByDepth: BracketNode[][] = [];
    for (let d = 0; d <= maxLevel; d++) {
      nodesByDepth.push(nodesArray.filter(n => n.depth === d));
    }

    const NODE_WIDTH = 220;
    const NODE_HEIGHT = 80;
    const X_GAP = 60;
    const Y_GAP = 20;

    // Determine Y order of leaves using a recursive DFS from roots.
    // Visiting Chung first then Hong ensures Chung is always above Hong visually without overlapping lines!
    const leafOrder: string[] = [];
    const visited = new Set<string>();

    function traverse(nodeId: string) {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      
      const node = nodeMap.get(nodeId);
      if (!node) return;

      if (node.sources.length === 0) {
        leafOrder.push(nodeId);
      } else {
        // Sort sources so Chung is first, Hong is second
        const sortedSources = [...node.sources].sort((a, b) => a.slot === 'Chung' ? -1 : 1);
        sortedSources.forEach(s => {
          traverse(s.sourceId);
        });
      }
    }

    // Sort roots consistently before starting traversal
    const sortedRoots = [...roots].sort((a, b) => a.id.localeCompare(b.id));
    sortedRoots.forEach(r => traverse(r.id));

    // Ensure all layout leaves (sources.length === 0) are in leafOrder
    nodesArray.forEach(n => {
      if (n.sources.length === 0 && !visited.has(n.id)) {
        leafOrder.push(n.id);
      }
    });

    // Assign Y to layout leaves from top-to-bottom
    let currentY = 20;
    leafOrder.forEach(nodeId => {
      const node = nodeMap.get(nodeId);
      if (node) {
        node.y = currentY;
        currentY += NODE_HEIGHT + Y_GAP;
      }
    });

    // Assign Y to parents (average of children) going from depth 1 up to maxLevel
    for (let d = 1; d <= maxLevel; d++) {
      nodesByDepth[d].forEach(node => {
        if (node.sources.length > 0) {
          const childYs = node.sources.map(s => nodeMap.get(s.sourceId)?.y ?? 0);
          node.y = childYs.reduce((a, b) => a + b, 0) / childYs.length;
          
          // Sort sources array so Chung is top, Hong is bottom visually
          node.sources.sort((a, b) => a.slot === 'Chung' ? -1 : 1);
        }
      });
    }

    // Assign X based on depth
    nodesArray.forEach(node => {
      node.x = node.depth * (NODE_WIDTH + X_GAP) + 20;
    });

    const totalWidth = (maxLevel + 1) * (NODE_WIDTH + X_GAP) + 40;
    const totalHeight = Math.max(currentY, Math.max(...nodesArray.map(n => n.y)) + NODE_HEIGHT + 40);

    // Build edges for SVG drawing
    interface Edge {
       id: string;
       startX: number;
       startY: number;
       endX: number;
       endY: number;
       slot?: string;
    }
    const svgEdges: Edge[] = [];
    
    nodesArray.forEach(node => {
      node.sources.forEach(source => {
         const sourceNode = nodeMap.get(source.sourceId);
         if (sourceNode) {
            svgEdges.push({
               id: `${source.sourceId}-${node.id}`,
               startX: sourceNode.x + NODE_WIDTH,      // Right side of source
               startY: sourceNode.y + NODE_HEIGHT / 2, // Middle of source
               endX: node.x,                           // Left side of target
               endY: node.y + (source.slot === 'Chung' ? 20 : NODE_HEIGHT - 20), // Target Chung is top, Hong is bottom relative to node Y
               slot: source.slot
            });
         }
      });
    });

    return { nodes: nodesArray, edges: svgEdges, width: totalWidth, height: totalHeight };
  }, [selectedCategory, mappings, boutQueue, matchHistory]);

  const cleanName = (name: string | undefined) => (!name || name === '---') ? '' : name;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black text-slate-800 tracking-tighter">Bout Chart</h2>
      </div>
      
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
         <div className="w-full md:w-1/3">
            <label className="text-xs font-black text-slate-500 uppercase tracking-widest ml-1 mb-2 block">Select Category</label>
            <select 
               value={selectedCategory}
               onChange={e => setSelectedCategory(e.target.value)}
               className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 font-bold"
            >
                <option value="">-- Choose Category --</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
         </div>
         
         {selectedCategory && (
            <div className="w-full overflow-x-auto overflow-y-auto pb-8 rounded-xl border border-slate-200 bg-slate-50" style={{ minHeight: 400 }}>
               {nodes.length === 0 ? (
                  <p className="text-slate-500 font-bold p-8 text-center">No brackets found for this category.</p>
               ) : (
                  <div style={{ width: Math.max(width, 600), height: Math.max(height, 400), position: 'relative' }}>
                     <svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
                        {edges.map((e, i) => {
                           // Define Path. Simple curve or right-angle lines.
                           // Standard bracket line: Horizontal, vertical, horizontal.
                           const midX = e.startX + (e.endX - e.startX) / 2;
                           const endY = e.startY; 
                           // Wait, standard brackets start from source middle, go to target port.
                           // Actually let's just go to target middle.
                           const tY = e.endY; // We can use e.endY which is mapped to slot.
                           const path = `M ${e.startX} ${e.startY} L ${midX} ${e.startY} L ${midX} ${tY} L ${e.endX} ${tY}`;
                           
                           return (
                             <path 
                               key={`${e.id}-${i}`}
                               d={path}
                               fill="none"
                               stroke="#cbd5e1"
                               strokeWidth="2"
                               strokeLinejoin="round"
                             />
                           );
                        })}
                     </svg>
                     
                     {nodes.map((node, i) => {
                        const m = node.match as any;
                        
                        // Parse winner. 
                        // MatchHistoryItem has 'winner', MatchData in queue has none unless we check what 'winner' is? Queue has no winner.
                        const winner = m && 'winner' in m ? m.winner : null; 
                        const nodeRing = m?.ring ? m.ring : parseRingNumber(node.id);
                        
                        return (
                          <div 
                             key={`${node.id}-${i}`} 
                             className="absolute bg-white border border-slate-300 rounded-lg shadow-sm overflow-hidden flex flex-col text-xs"
                             style={{ left: node.x, top: node.y, width: 220, height: 80 }}
                          >
                             <div className="bg-slate-100 border-b border-slate-200 px-2 py-1 flex justify-between items-center text-[10px] font-black uppercase text-slate-500">
                                {editingNodeId === node.id ? (
                                   <input
                                      autoFocus
                                      type="text"
                                      className="border border-blue-400 bg-white rounded px-1 w-20 outline-none text-black"
                                      value={editValue}
                                      onChange={(e) => setEditValue(e.target.value)}
                                      onKeyDown={(e) => {
                                         if (e.key === 'Enter') {
                                            if (editValue.trim() && editValue !== node.id) {
                                               onUpdateBoutNumber?.(node.id, editValue.trim());
                                            }
                                            setEditingNodeId(null);
                                         }
                                         if (e.key === 'Escape') setEditingNodeId(null);
                                      }}
                                      onBlur={() => {
                                         if (editValue.trim() && editValue !== node.id) {
                                            onUpdateBoutNumber?.(node.id, editValue.trim());
                                         }
                                         setEditingNodeId(null);
                                      }}
                                   />
                                ) : (
                                   <span 
                                      className="cursor-pointer hover:text-blue-600 transition-colors"
                                      onClick={() => {
                                         setEditingNodeId(node.id);
                                         setEditValue(node.id); // Or formatBoutNumber if you want to edit formatted? Best to edit raw ID
                                      }}
                                      title="Click to edit bout number"
                                   >
                                      Bout {formatBoutNumber(nodeRing, node.id, boutNumberingMode)}
                                   </span>
                                )}
                                {winner && <span className="text-green-600">Completed</span>}
                             </div>
                             <div className="flex-1 flex flex-col justify-center">
                                <div className={`flex justify-between items-center px-2 py-1 pl-2 border-l-4 border-blue-500 ${winner === 'Blue' ? 'font-bold bg-blue-50 text-blue-700' : 'text-slate-700'}`}>
                                   {editingNameNodeId === node.id && editingNameColor === 'blue' ? (
                                      <input
                                         autoFocus
                                         type="text"
                                         className="border border-blue-400 bg-white rounded px-1 w-full outline-none text-black text-xs"
                                         value={editNameValue}
                                         onChange={(e) => setEditNameValue(e.target.value)}
                                         onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                               if (editNameValue.trim() !== (m?.blue_name || '')) {
                                                  onUpdateBoutName?.(node.id, 'blue', editNameValue.trim());
                                               }
                                               setEditingNameNodeId(null);
                                               setEditingNameColor(null);
                                            }
                                            if (e.key === 'Escape') {
                                               setEditingNameNodeId(null);
                                               setEditingNameColor(null);
                                            }
                                         }}
                                         onBlur={() => {
                                            if (editNameValue.trim() !== (m?.blue_name || '')) {
                                               onUpdateBoutName?.(node.id, 'blue', editNameValue.trim());
                                            }
                                            setEditingNameNodeId(null);
                                            setEditingNameColor(null);
                                         }}
                                      />
                                   ) : (
                                      <span 
                                         className="truncate w-full pr-2 cursor-pointer hover:bg-slate-200 hover:text-slate-900 transition-colors"
                                         onClick={() => {
                                            setEditingNameNodeId(node.id);
                                            setEditingNameColor('blue');
                                            setEditNameValue(m?.blue_name || '');
                                         }}
                                         title="Click to edit name"
                                      >
                                         {m ? cleanName(m.blue_name) || <span className="italic text-slate-300">TBD</span> : <span className="italic text-slate-300">Unknown</span>}
                                      </span>
                                   )}
                                </div>
                                <div className="border-t border-slate-100"></div>
                                <div className={`flex justify-between items-center px-2 py-1 pl-2 border-l-4 border-red-500 ${winner === 'Red' ? 'font-bold bg-red-50 text-red-700' : 'text-slate-700'}`}>
                                   {editingNameNodeId === node.id && editingNameColor === 'red' ? (
                                      <input
                                         autoFocus
                                         type="text"
                                         className="border border-red-400 bg-white rounded px-1 w-full outline-none text-black text-xs"
                                         value={editNameValue}
                                         onChange={(e) => setEditNameValue(e.target.value)}
                                         onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                               if (editNameValue.trim() !== (m?.red_name || '')) {
                                                  onUpdateBoutName?.(node.id, 'red', editNameValue.trim());
                                               }
                                               setEditingNameNodeId(null);
                                               setEditingNameColor(null);
                                            }
                                            if (e.key === 'Escape') {
                                               setEditingNameNodeId(null);
                                               setEditingNameColor(null);
                                            }
                                         }}
                                         onBlur={() => {
                                            if (editNameValue.trim() !== (m?.red_name || '')) {
                                               onUpdateBoutName?.(node.id, 'red', editNameValue.trim());
                                            }
                                            setEditingNameNodeId(null);
                                            setEditingNameColor(null);
                                         }}
                                      />
                                   ) : (
                                      <span 
                                         className="truncate w-full pr-2 cursor-pointer hover:bg-slate-200 hover:text-slate-900 transition-colors"
                                         onClick={() => {
                                            setEditingNameNodeId(node.id);
                                            setEditingNameColor('red');
                                            setEditNameValue(m?.red_name || '');
                                         }}
                                         title="Click to edit name"
                                      >
                                         {m ? cleanName(m.red_name) || <span className="italic text-slate-300">TBD</span> : <span className="italic text-slate-300">Unknown</span>}
                                      </span>
                                   )}
                                </div>
                             </div>
                          </div>
                        )
                     })}
                  </div>
               )}
            </div>
         )}
      </div>
    </div>
  );
}

