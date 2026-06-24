import React, { useState, useEffect, useMemo } from 'react';
import { EventData, MatchHistoryItem, MatchData, RingStatus } from '../types';
import { Download, RefreshCw, Trophy, Medal, Building2, Search } from 'lucide-react';
import Papa from 'papaparse';
import { getBoutNumber, isBoutMatch, cn, normalizeBoutNumber } from '../lib/utils';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';

interface EventReportProps {
  currentEventId: string | null;
  events: EventData[];
  matchHistory: MatchHistoryItem[];
  boutQueue: { id: string; data: MatchData }[];
  rings: RingStatus[];
}

interface RawMatch {
  event: string;
  category: string;
  matchNoStr: string;
  matchNo: number;
  blueName: string;
  blueClub: string;
  redName: string;
  redClub: string;
  winner: string;
}

interface WinnerResult {
  place: '1st' | '2nd' | '3rd' | '4th';
  name: string;
  club: string;
}

interface CategoryResult {
  category: string;
  gold: WinnerResult | null;
  silver: WinnerResult | null;
  bronzes: WinnerResult[];
}

export function EventReport({ currentEventId, events, matchHistory, boutQueue, rings }: EventReportProps) {
  const [activeTab, setActiveTab] = useState<'winners' | 'by-rank' | 'summary'>('winners');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<RawMatch[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Option A (Joint 3rd Place) vs Option B (3rd Place Playoff)
  const [placementOption, setPlacementOption] = useState<'a' | 'b'>('b');
  
  // Feature: Option to combine multiple events
  const [includeAllEvents, setIncludeAllEvents] = useState(false);

  const fetchMatches = async () => {
    const targetEvents = includeAllEvents 
      ? events
      : events.filter(e => e.id === currentEventId);

    if (targetEvents.length === 0) {
      if (!currentEventId) return; // Silent if just no event selected
      setError("No valid events selected.");
      setMatches([]);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    try {
      let combinedMatches: RawMatch[] = [];

      for (const event of targetEvents) {
        // 1. Get bracket matches from Firestore
        let bracketMatches: any[] = [];
        try {
          const bracketRef = doc(db, 'tournaments', event.id, 'bracket', 'data');
          const bracketSnap = await getDoc(bracketRef);
          if (bracketSnap.exists()) {
            bracketMatches = bracketSnap.data().matches || [];
          }
        } catch (err) {
          console.warn(`Error fetching bracket matches for event ${event.id}:`, err);
        }

        // 2. Get matchHistory for this event
        const eventHistory = matchHistory.filter(h => h.eventId === event.id);

        // 3. Get boutQueue for this event
        const eventQueue = boutQueue.filter(q => q.data.eventId === event.id);

        // 4. Get rings bouts for this event
        const eventRingsBouts: MatchData[] = [];
        rings.forEach(r => {
          if (r.eventId === event.id || (!r.eventId && r.currentBout?.eventId === event.id)) {
            if (r.currentBout) eventRingsBouts.push(r.currentBout);
            if (r.onDeck) eventRingsBouts.push(r.onDeck);
            if (r.inTheHole) eventRingsBouts.push(r.inTheHole);
          }
        });

        // Unique keys tracker
        const seenKeys = new Set<string>();

        const addMatchIfNew = (
          boutStr: string | number,
          category: string,
          blueName: string,
          blueClub: string,
          redName: string,
          redClub: string,
          winnerVal: string
        ) => {
          const bStr = boutStr.toString().trim();
          const catStr = category.trim();
          if (!bStr || !catStr) return;
          const key = `${normalizeBoutNumber(bStr)}_${catStr.toLowerCase()}`;
          if (seenKeys.has(key)) return;
          seenKeys.add(key);

          combinedMatches.push({
            event: event.name,
            category: catStr,
            matchNoStr: bStr,
            matchNo: getBoutNumber(bStr),
            blueName: blueName.trim(),
            blueClub: blueClub.trim(),
            redName: redName.trim(),
            redClub: redClub.trim(),
            winner: winnerVal.trim()
          });
        };

        // Priority 1: Match History (completed matches with winners)
        eventHistory.forEach(hist => {
          const bMatch = bracketMatches.find(m => isBoutMatch(m.bout, hist.bout) && m.category === hist.category);
          const qMatch = eventQueue.find(q => isBoutMatch(q.data.bout, hist.bout) && q.data.category === hist.category);
          const rMatch = eventRingsBouts.find(b => isBoutMatch(b.bout, hist.bout) && b.category === hist.category);

          const blueName = qMatch?.data.blue_name || rMatch?.blue_name || bMatch?.blue_name || bMatch?.blueName || '';
          const blueClub = qMatch?.data.blue_club || rMatch?.blue_club || bMatch?.blue_club || bMatch?.blueClub || '';
          const redName = qMatch?.data.red_name || rMatch?.red_name || bMatch?.red_name || bMatch?.redName || '';
          const redClub = qMatch?.data.red_club || rMatch?.red_club || bMatch?.red_club || bMatch?.redClub || '';

          let finalWinner = hist.winner || '';
          if (hist.winnerSide === 'Blue' && blueName) {
            finalWinner = blueName;
          } else if (hist.winnerSide === 'Red' && redName) {
            finalWinner = redName;
          }

          addMatchIfNew(hist.bout, hist.category, blueName, blueClub, redName, redClub, finalWinner);
        });

        // Priority 2: Active/pending matches from queue
        eventQueue.forEach(q => {
          addMatchIfNew(q.data.bout, q.data.category, q.data.blue_name, q.data.blue_club, q.data.red_name, q.data.red_club, '');
        });

        // Priority 3: Matches in rings
        eventRingsBouts.forEach(b => {
          addMatchIfNew(b.bout, b.category, b.blue_name, b.blue_club, b.red_name, b.red_club, '');
        });

        // Priority 4: Bracket matches
        bracketMatches.forEach(bm => {
          addMatchIfNew(bm.bout, bm.category || '', bm.blue_name || bm.blueName || '', bm.blue_club || bm.blueClub || '', bm.red_name || bm.redName || '', bm.red_club || bm.redClub || '', '');
        });
      }

      setMatches(combinedMatches);
      
      if (combinedMatches.length === 0) {
        setError("No tournament matches found in the system for the selected event.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMatches();
  }, [currentEventId, includeAllEvents, matchHistory, boutQueue, rings]);

  const categoryResults = useMemo(() => {
    // Helper to recursively unwrap "WINNER OF X" into the actual player name
    const resolveParticipant = (name: string, fallbackClub: string, category: string, currentMatchNoStr: string, visited: Set<string> = new Set()): { name: string, club: string } => {
      const trimmed = name.trim();
      const winMatch = trimmed.match(/^winner of\s+(.+)$/i);
      
      if (!winMatch) return { name: trimmed, club: fallbackClub };
      
      let sourceBoutStr = winMatch[1].trim();
      if (sourceBoutStr.toUpperCase().startsWith("BOUT ")) {
        sourceBoutStr = sourceBoutStr.substring(5).trim();
      }
      
      if (visited.has(sourceBoutStr)) return { name: trimmed, club: fallbackClub }; // prevent infinite loops
      visited.add(sourceBoutStr);

      // Attempt 1: Exact match with Ring Prefix injected
      let preferredSourceBoutStr = sourceBoutStr;
      const isPureNumeric = /^\d+$/.test(sourceBoutStr);
      const ringPrefixMatch = currentMatchNoStr.match(/^[A-Z]+/i);

      if (isPureNumeric && ringPrefixMatch) {
         const pref = ringPrefixMatch[0];
         const numAsInt = parseInt(sourceBoutStr, 10);
         const paddedNum = numAsInt < 10 ? `0${numAsInt}` : numAsInt.toString();
         preferredSourceBoutStr = `${pref.toUpperCase()}${paddedNum}`;
      }

      // First criteria: Exact match with intelligent Ring prefix applied
      let sourceMatch = matches.find(m => m.category === category && m.matchNoStr.toUpperCase() === preferredSourceBoutStr.toUpperCase());
      
      // Fallback criteria: Use our lenient boolean check across the category
      if (!sourceMatch) {
         sourceMatch = matches.find(m => m.category === category && isBoutMatch(m.matchNoStr, sourceBoutStr));
      }

      if (!sourceMatch || !sourceMatch.winner || sourceMatch.winner === '-') {
        return { name: trimmed, club: fallbackClub };
      }

      // Find who won the source match
      const sWinnerLower = sourceMatch.winner.trim().toLowerCase();
      const isSBlue = sWinnerLower === sourceMatch.blueName.toLowerCase() || 
                      sWinnerLower === 'winner blue' || sWinnerLower === 'blue' || sWinnerLower === 'completed';
      const isSRed = sWinnerLower === sourceMatch.redName.toLowerCase() || 
                     sWinnerLower === 'winner red' || sWinnerLower === 'red';

      if (isSBlue) {
        return resolveParticipant(sourceMatch.blueName, sourceMatch.blueClub, category, sourceMatch.matchNoStr, visited);
      } else if (isSRed) {
        return resolveParticipant(sourceMatch.redName, sourceMatch.redClub, category, sourceMatch.matchNoStr, visited);
      } else {
        if (sourceMatch.blueName.toLowerCase().includes(sWinnerLower)) {
           return resolveParticipant(sourceMatch.blueName, sourceMatch.blueClub, category, sourceMatch.matchNoStr, visited);
        }
        if (sourceMatch.redName.toLowerCase().includes(sWinnerLower)) {
           return resolveParticipant(sourceMatch.redName, sourceMatch.redClub, category, sourceMatch.matchNoStr, visited);
        }
        // If we can't figure out who it maps to, just use the raw winner string
        return { name: sourceMatch.winner, club: fallbackClub };
      }
    };

    // Create a copy of matches with all "WINNER OF X" placeholders fully populated
    const resolvedMatches = matches.map(m => {
       const blueResolved = resolveParticipant(m.blueName, m.blueClub, m.category, m.matchNoStr, new Set());
       const redResolved = resolveParticipant(m.redName, m.redClub, m.category, m.matchNoStr, new Set());
       // Also attempt to resolve if the actual 'winner' field was typed as 'winner of X' (rare, but just in case)
       const winnerResolved = resolveParticipant(m.winner, '', m.category, m.matchNoStr, new Set());

       // If the system parsed 'winner' as blue or red, ensure it maps to the newly resolved name correctly for downstream logic
       let newWinner = m.winner;
       const rawWinnerL = m.winner.trim().toLowerCase();
       if (rawWinnerL === m.blueName.trim().toLowerCase() || rawWinnerL === 'winner blue' || rawWinnerL === 'blue') {
         newWinner = blueResolved.name;
       } else if (rawWinnerL === m.redName.trim().toLowerCase() || rawWinnerL === 'winner red' || rawWinnerL === 'red') {
         newWinner = redResolved.name;
       } else if (winnerResolved.name !== m.winner) {
         newWinner = winnerResolved.name;
       }

       return {
         ...m,
         blueName: blueResolved.name,
         blueClub: blueResolved.club || m.blueClub,
         redName: redResolved.name,
         redClub: redResolved.club || m.redClub,
         winner: newWinner
       };
    });

    const categories = Array.from(new Set(resolvedMatches.map(m => m.category))).filter((c): c is string => !!c);
    const results: CategoryResult[] = [];

    categories.forEach((cat: string) => {
      // Find all matches for this category
      const catMatches = resolvedMatches.filter(m => m.category === cat);
      if (catMatches.length === 0) return;

      // Sort by match number descending to find the final
      catMatches.sort((a, b) => b.matchNo - a.matchNo);
      
      const finalMatch = catMatches[0];
      if (!finalMatch || !finalMatch.winner || finalMatch.winner === '-') {
        // Final not completed yet
        results.push({ category: cat, gold: null, silver: null, bronzes: [] });
        return;
      }

      // Determine Gold and Silver
      let goldName = finalMatch.winner;
      let goldClub = '';
      let silverName = '';
      let silverClub = '';

      const winnerLower = goldName.trim().toLowerCase();
      
      const isWinnerBlue = winnerLower === finalMatch.blueName.toLowerCase() || 
                           winnerLower === 'winner blue' || 
                           winnerLower === 'blue' ||
                           winnerLower === 'completed';

      const isWinnerRed = winnerLower === finalMatch.redName.toLowerCase() || 
                          winnerLower === 'winner red' || 
                          winnerLower === 'red';

      if (isWinnerBlue) {
        goldName = finalMatch.blueName;
        goldClub = finalMatch.blueClub;
        silverName = finalMatch.redName || '-';
        silverClub = finalMatch.redClub || '-';
      } else if (isWinnerRed) {
        goldName = finalMatch.redName;
        goldClub = finalMatch.redClub;
        silverName = finalMatch.blueName || '-';
        silverClub = finalMatch.blueClub || '-';
      } else {
        // Fallback fuzzy match
        if (finalMatch.blueName.toLowerCase().includes(winnerLower)) {
          goldName = finalMatch.blueName;
          goldClub = finalMatch.blueClub;
          silverName = finalMatch.redName || '-';
          silverClub = finalMatch.redClub || '-';
        } else {
          goldName = finalMatch.redName || finalMatch.winner; // fallback if we can't find it
          goldClub = finalMatch.redClub;
          silverName = finalMatch.blueName || '-';
          silverClub = finalMatch.blueClub || '-';
        }
      }

      // Determine Bronzes and 4th place
      const bronzes: WinnerResult[] = [];

      // Find Semi-Finalist 1's previous match & loser (who lost to Gold in Gold's previous match)
      let goldPrevMatch;
      let semi1LoserName = '';
      let semi1LoserClub = '';
      if (goldName && goldName !== '-' && goldName.toLowerCase() !== 'bye') {
        goldPrevMatch = catMatches.find(m => 
          m.matchNo < finalMatch.matchNo &&
          (m.blueName.toLowerCase() === goldName.toLowerCase() || m.redName.toLowerCase() === goldName.toLowerCase())
        );
      }

      if (goldPrevMatch) {
         if (goldPrevMatch.blueName.toLowerCase() === goldName.toLowerCase()) {
           semi1LoserName = goldPrevMatch.redName;
           semi1LoserClub = goldPrevMatch.redClub;
         } else {
           semi1LoserName = goldPrevMatch.blueName;
           semi1LoserClub = goldPrevMatch.blueClub;
         }
      }

      // Find Semi-Finalist 2's previous match & loser (who lost to Silver in Silver's previous match)
      let silverPrevMatch;
      let semi2LoserName = '';
      let semi2LoserClub = '';
      if (silverName && silverName !== '-' && silverName.toLowerCase() !== 'bye') {
        silverPrevMatch = catMatches.find(m => 
          m.matchNo < finalMatch.matchNo &&
          (m.blueName.toLowerCase() === silverName.toLowerCase() || m.redName.toLowerCase() === silverName.toLowerCase())
        );
      }

      if (silverPrevMatch) {
         if (silverPrevMatch.blueName.toLowerCase() === silverName.toLowerCase()) {
           semi2LoserName = silverPrevMatch.redName;
           semi2LoserClub = silverPrevMatch.redClub;
         } else {
           semi2LoserName = silverPrevMatch.blueName;
           semi2LoserClub = silverPrevMatch.blueClub;
         }
      }

      // Look for a specific "Third Place Playoff" / "Bronze medal match"
      let thirdPlaceMatch = catMatches.find(m => 
        m.matchNoStr.toUpperCase().includes("BRONZE") || 
        m.matchNoStr.toUpperCase().includes("3RD") ||
        (semi1LoserName && semi2LoserName && 
         ((m.blueName.toLowerCase() === semi1LoserName.toLowerCase() && m.redName.toLowerCase() === semi2LoserName.toLowerCase()) ||
          (m.redName.toLowerCase() === semi1LoserName.toLowerCase() && m.blueName.toLowerCase() === semi2LoserName.toLowerCase())))
      );

      if (placementOption === 'b' && thirdPlaceMatch && thirdPlaceMatch.winner && thirdPlaceMatch.winner !== '-') {
        // Option B: Decide 3rd and 4th using the third-place playoff match
        const tWinnerLower = thirdPlaceMatch.winner.trim().toLowerCase();
        let thirdName = thirdPlaceMatch.winner;
        let thirdClub = '';
        let fourthName = '';
        let fourthClub = '';

        const isTWinnerBlue = tWinnerLower === thirdPlaceMatch.blueName.toLowerCase() || 
                             tWinnerLower === 'winner blue' || 
                             tWinnerLower === 'blue';
        const isTWinnerRed = tWinnerLower === thirdPlaceMatch.redName.toLowerCase() || 
                            tWinnerLower === 'winner red' || 
                            tWinnerLower === 'red';

        if (isTWinnerBlue) {
          thirdName = thirdPlaceMatch.blueName;
          thirdClub = thirdPlaceMatch.blueClub;
          fourthName = thirdPlaceMatch.redName;
          fourthClub = thirdPlaceMatch.redClub;
        } else if (isTWinnerRed) {
          thirdName = thirdPlaceMatch.redName;
          thirdClub = thirdPlaceMatch.redClub;
          fourthName = thirdPlaceMatch.blueName;
          fourthClub = thirdPlaceMatch.blueClub;
        } else {
          if (thirdPlaceMatch.blueName.toLowerCase().includes(tWinnerLower)) {
            thirdName = thirdPlaceMatch.blueName;
            thirdClub = thirdPlaceMatch.blueClub;
            fourthName = thirdPlaceMatch.redName;
            fourthClub = thirdPlaceMatch.redClub;
          } else {
            thirdName = thirdPlaceMatch.redName || thirdPlaceMatch.winner;
            thirdClub = thirdPlaceMatch.redClub;
            fourthName = thirdPlaceMatch.blueName;
            fourthClub = thirdPlaceMatch.blueClub;
          }
        }

        if (thirdName && thirdName !== '-' && thirdName.toLowerCase() !== 'bye') {
          bronzes.push({ place: '3rd', name: thirdName, club: thirdClub });
        }
        if (fourthName && fourthName !== '-' && fourthName.toLowerCase() !== 'bye') {
          bronzes.push({ place: '4th', name: fourthName, club: fourthClub });
        }
      } else {
        // Option A (Joint 3rd Place): Award both Semi-final losers with a 3rd place
        if (semi1LoserName && semi1LoserName !== '-' && semi1LoserName.toLowerCase() !== 'bye') {
          bronzes.push({ place: '3rd', name: semi1LoserName, club: semi1LoserClub });
        }
        if (semi2LoserName && semi2LoserName !== '-' && semi2LoserName.toLowerCase() !== 'bye') {
          bronzes.push({ place: '3rd', name: semi2LoserName, club: semi2LoserClub });
        }
      }

      results.push({
        category: cat,
        gold: { place: '1st', name: goldName, club: goldClub },
        silver: { place: '2nd', name: silverName, club: silverClub },
        bronzes
      });
    });

    // Sort categories alphabetically
    return results.sort((a, b) => a.category.localeCompare(b.category));
  }, [matches, placementOption]);

  const clubStandings = useMemo(() => {
    const pointsTracker: Record<string, { gold: number, silver: number, bronze: number, points: number }> = {};

    categoryResults.forEach(res => {
      if (res.gold?.club) {
        if (!pointsTracker[res.gold.club]) pointsTracker[res.gold.club] = { gold: 0, silver: 0, bronze: 0, points: 0 };
        pointsTracker[res.gold.club].gold += 1;
        pointsTracker[res.gold.club].points += 7;
      }
      if (res.silver?.club) {
        if (!pointsTracker[res.silver.club]) pointsTracker[res.silver.club] = { gold: 0, silver: 0, bronze: 0, points: 0 };
        pointsTracker[res.silver.club].silver += 1;
        pointsTracker[res.silver.club].points += 3;
      }
      res.bronzes.forEach(b => {
        if (b.club) {
            if (!pointsTracker[b.club]) pointsTracker[b.club] = { gold: 0, silver: 0, bronze: 0, points: 0 };
            pointsTracker[b.club].bronze += 1;
            pointsTracker[b.club].points += 1;
        }
      });
    });

    const standingsArr = Object.keys(pointsTracker).map(club => ({
      club,
      ...pointsTracker[club]
    }));

    // Sort by Total Points -> Most Golds -> Most Silvers -> Most Bronzes
    standingsArr.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gold !== a.gold) return b.gold - a.gold;
      if (b.silver !== a.silver) return b.silver - a.silver;
      return b.bronze - a.bronze;
    });

    return standingsArr;
  }, [categoryResults]);

  const filteredCategories = categoryResults.filter(c => c.category.toLowerCase().includes(searchQuery.toLowerCase()));

  const allGolds = useMemo(() => {
    return categoryResults
      .filter(c => c.gold?.name && c.gold.name !== '-')
      .map(c => ({ ...c.gold!, category: c.category }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categoryResults]);

  const allSilvers = useMemo(() => {
    return categoryResults
      .filter(c => c.silver?.name && c.silver.name !== '-')
      .map(c => ({ ...c.silver!, category: c.category }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categoryResults]);

  const allBronzes = useMemo(() => {
    return categoryResults
      .flatMap(c => c.bronzes.map(b => ({ ...b, category: c.category })))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categoryResults]);

  const filteredGolds = allGolds.filter(g => 
    g.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    g.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (g.club && g.club.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredSilvers = allSilvers.filter(g => 
    g.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    g.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (g.club && g.club.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredBronzes = allBronzes.filter(g => 
    g.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    g.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (g.club && g.club.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const downloadCategoryPlacings = () => {
    const data = filteredCategories.map(c => {
      const b1 = c.bronzes.find(b => b.place === '3rd') || c.bronzes[0] || { name: '', club: '', place: '3rd' };
      const b2 = c.bronzes.find(b => b.place === '4th') || c.bronzes[1] || { name: '', club: '', place: '3rd' };
      const b2RankLabel = b2.place === '4th' ? '4th Place' : '3rd Place (Bronze 2)';
      const b2ClubLabel = b2.place === '4th' ? '4th Place Club' : '3rd Place Club 2';
      return {
        'Category': c.category,
        '1st Place (Gold)': c.gold?.name || '',
        '1st Place Club': c.gold?.club || '',
        '2nd Place (Silver)': c.silver?.name || '',
        '2nd Place Club': c.silver?.club || '',
        '3rd Place (Bronze 1)': b1.name || '',
        '3rd Place Club 1': b1.club || '',
        [b2RankLabel]: b2.name || '',
        [b2ClubLabel]: b2.club || ''
      };
    });
    
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `category_placings_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadOverallWinners = () => {
    const data: any[] = [];
    
    filteredGolds.forEach(g => {
      data.push({
        'Rank': '1st Place (Gold)',
        'Athlete Name': g.name,
        'Club Name': g.club,
        'Category': g.category
      });
    });
    
    filteredSilvers.forEach(s => {
      data.push({
        'Rank': '2nd Place (Silver)',
        'Athlete Name': s.name,
        'Club Name': s.club,
        'Category': s.category
      });
    });
    
    filteredBronzes.forEach(b => {
      data.push({
        'Rank': '3rd Place (Bronze)',
        'Athlete Name': b.name,
        'Club Name': b.club,
        'Category': b.category
      });
    });
    
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `overall_winners_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadOverallStandings = () => {
    const data = clubStandings.map((c, i) => ({
      'Rank': i + 1,
      'Club / State': c.club || 'Unknown Club',
      'Gold Medals': c.gold,
      'Silver Medals': c.silver,
      'Bronze Medals': c.bronze,
      'Total Points': c.points
    }));
    
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `overall_standings_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!currentEventId) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500">
        <Trophy size={48} className="text-slate-300 mb-4" />
        <h2 className="text-xl font-bold">No Event Selected</h2>
        <p>Please select an event from the top right to view reports.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-end bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            <Trophy className="text-blue-600" />
            Tournament Report
          </h1>
          <p className="text-slate-500 mt-1 flex items-center gap-2">
            {!includeAllEvents ? (
              events.find(e => e.id === currentEventId)?.name || 'Unknown Event'
            ) : (
              `Aggregating across ${events.length} events`
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 p-1 rounded-xl">
            <button
              onClick={() => setPlacementOption('a')}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-black transition-all uppercase tracking-wide",
                placementOption === 'a' 
                  ? "bg-red-600 text-white shadow-sm" 
                  : "text-slate-600 hover:bg-slate-200"
              )}
              title="Option A: Both Semi-Final losers are awarded Joint 3rd place (WT standard)"
            >
              Option A (Joint 3rd)
            </button>
            <button
              onClick={() => setPlacementOption('b')}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-black transition-all uppercase tracking-wide",
                placementOption === 'b' 
                  ? "bg-red-600 text-white shadow-sm" 
                  : "text-slate-600 hover:bg-slate-200"
              )}
              title="Option B: 3rd and 4th place decided via Bronze Medal Match playoff"
            >
              Option B (Playoff)
            </button>
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-slate-600 font-medium bg-slate-50 px-4 py-2 rounded-xl hover:bg-slate-100 transition-colors h-[40px]">
            <input 
              type="checkbox" 
              checked={includeAllEvents}
              onChange={(e) => setIncludeAllEvents(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            Merge Multiple Days / Events
          </label>
          <button 
            onClick={fetchMatches}
            disabled={isLoading}
            className="px-4 py-2 bg-blue-50 text-blue-700 hover:bg-blue-100 font-bold rounded-xl flex items-center gap-2 transition-all h-[40px]"
          >
            <RefreshCw size={18} className={cn(isLoading && "animate-spin")} />
            {isLoading ? "Analyzing Data..." : "Refresh Report"}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-xl border border-red-200 font-medium">
          {error}
        </div>
      )}

      {/* TABS */}
      <div className="flex gap-4 border-b border-slate-200 pb-px">
        <button
          onClick={() => setActiveTab('winners')}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-wide rounded-t-xl transition-all relative",
            activeTab === 'winners' 
              ? "text-blue-700 bg-white border border-b-0 border-slate-200" 
              : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          )}
        >
          Category Placings
          {activeTab === 'winners' && <div className="absolute -bottom-px left-0 right-0 h-px bg-white" />}
        </button>
        <button
          onClick={() => setActiveTab('by-rank')}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-wide rounded-t-xl transition-all relative",
            activeTab === 'by-rank' 
              ? "text-blue-700 bg-white border border-b-0 border-slate-200" 
              : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          )}
        >
          Club/State Overall Winner by Category
          {activeTab === 'by-rank' && <div className="absolute -bottom-px left-0 right-0 h-px bg-white" />}
        </button>
        <button
          onClick={() => setActiveTab('summary')}
          className={cn(
            "px-6 py-3 font-bold text-sm tracking-wide rounded-t-xl transition-all relative",
            activeTab === 'summary' 
              ? "text-blue-700 bg-white border border-b-0 border-slate-200" 
              : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
          )}
        >
          Overall Standings (WT Calc)
          {activeTab === 'summary' && <div className="absolute -bottom-px left-0 right-0 h-px bg-white" />}
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {activeTab === 'winners' && (
          <div className="p-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <h2 className="text-lg font-bold text-slate-800">Category Placings</h2>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={downloadCategoryPlacings}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl flex items-center gap-2 text-sm transition-all shadow-sm"
                >
                  <Download size={16} />
                  Download Placings CSV
                </button>
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search Category..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none w-64 text-sm"
                  />
                </div>
              </div>
            </div>
 
             <div className="overflow-x-auto">
               <table className="w-full text-left border-collapse">
                 <thead>
                   <tr className="bg-slate-50 border-b border-slate-200">
                     <th className="p-4 font-bold text-slate-600 text-sm">Category</th>
                     <th className="p-4 font-bold text-slate-600 text-sm"><div className="flex items-center gap-1"><Medal size={16} className="text-yellow-500"/> 1st Place (Gold)</div></th>
                     <th className="p-4 font-bold text-slate-600 text-sm"><div className="flex items-center gap-1"><Medal size={16} className="text-slate-400"/> 2nd Place (Silver)</div></th>
                     <th className="p-4 font-bold text-slate-600 text-sm"><div className="flex items-center gap-1"><Medal size={16} className="text-amber-700"/> 3rd Place (Bronzes)</div></th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-slate-100">
                   {filteredCategories.length === 0 ? (
                     <tr>
                       <td colSpan={4} className="p-8 text-center text-slate-500">
                         {isLoading ? "Scanning bracket history..." : "No categories processed yet. Check if tournament bouts have been started or completed in the Rings."}
                       </td>
                     </tr>
                   ) : filteredCategories.map((c, i) => (
                     <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                       <td className="p-4 font-bold text-slate-800">{c.category}</td>
                       <td className="p-4">
                         {c.gold ? (
                           <div>
                             <div className="font-bold text-slate-900">{c.gold.name}</div>
                             <div className="text-xs text-blue-900 font-bold">{c.gold.club}</div>
                           </div>
                         ) : <span className="text-slate-400 text-sm italic">Pending Finish</span>}
                       </td>
                       <td className="p-4">
                         {c.silver ? (
                           <div>
                             <div className="font-bold text-slate-700">{c.silver.name}</div>
                             <div className="text-xs text-blue-900 font-bold">{c.silver.club}</div>
                           </div>
                         ) : <span className="text-slate-400">-</span>}
                       </td>
                       <td className="p-4">
                         {c.bronzes.length > 0 ? (
                           <div className="flex flex-col gap-2">
                             {c.bronzes.map((b, bi) => (
                               <div key={bi} className={cn("px-2 py-1 rounded border inline-block w-max", b.place === '4th' ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-amber-50 border-amber-100")}>
                                 <div className="font-bold text-slate-800 text-sm flex gap-2"><span>{b.name}</span><span className={cn("font-black", b.place === '4th' ? "text-slate-500" : "text-amber-700/60")}>{b.place === '4th' ? '#4' : '#3'}</span></div>
                                 <div className="text-xs text-blue-900 font-bold">{b.club}</div>
                               </div>
                             ))}
                           </div>
                         ) : <span className="text-slate-400">-</span>}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
          </div>
        )}

        {activeTab === 'by-rank' && (
          <div className="p-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <h2 className="text-lg font-bold text-slate-800">Club/State Overall Winner by Category</h2>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={downloadOverallWinners}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl flex items-center gap-2 text-sm transition-all shadow-sm"
                >
                  <Download size={16} />
                  Download Winners CSV
                </button>
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search Names, Clubs..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none w-64 text-sm"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-12">
              {/* 1st Place Section */}
              <div>
                <h3 className="text-lg font-black text-yellow-600 flex items-center gap-2 mb-4 border-b border-yellow-100 pb-2">
                  <Medal size={20} className="text-yellow-500" /> 1st Place overall (Gold)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredGolds.length === 0 ? (
                    <div className="text-slate-500 italic">No gold winners found.</div>
                  ) : filteredGolds.map((g, i) => (
                    <div key={i} className="bg-white border text-left border-yellow-200 rounded-xl max-w-sm p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="font-black text-slate-900 text-lg leading-tight uppercase mb-1">{g.name}</div>
                      <div className="text-sm font-bold text-blue-900 uppercase tracking-widest">{g.club}</div>
                      <div className="text-xs text-slate-500 mt-3 pt-3 border-t border-slate-100">{g.category}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 2nd Place Section */}
              <div>
                <h3 className="text-lg font-black text-slate-600 flex items-center gap-2 mb-4 border-b border-slate-100 pb-2">
                  <Medal size={20} className="text-slate-400" /> 2nd Place overall (Silver)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredSilvers.length === 0 ? (
                    <div className="text-slate-500 italic">No silver winners found.</div>
                  ) : filteredSilvers.map((s, i) => (
                    <div key={i} className="bg-white border text-left border-slate-200 rounded-xl max-w-sm p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="font-black text-slate-900 text-lg leading-tight uppercase mb-1">{s.name}</div>
                      <div className="text-sm font-bold text-blue-900 uppercase tracking-widest">{s.club}</div>
                      <div className="text-xs text-slate-500 mt-3 pt-3 border-t border-slate-100">{s.category}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 3rd Place Section */}
              <div>
                <h3 className="text-lg font-black text-amber-700 flex items-center gap-2 mb-4 border-b border-amber-100 pb-2">
                  <Medal size={20} className="text-amber-600" /> 3rd Place overall (Bronze)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filteredBronzes.length === 0 ? (
                    <div className="text-slate-500 italic">No bronze winners found.</div>
                  ) : filteredBronzes.map((b, i) => (
                    <div key={i} className="bg-white border text-left border-amber-200 rounded-xl max-w-sm p-4 shadow-sm hover:shadow-md transition-shadow">
                      <div className="font-black text-slate-900 text-lg leading-tight uppercase mb-1">{b.name}</div>
                      <div className="text-sm font-bold text-blue-900 uppercase tracking-widest">{b.club}</div>
                      <div className="text-xs text-slate-500 mt-3 pt-3 border-t border-slate-100">{b.category}</div>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
        )}

        {activeTab === 'summary' && (
          <div className="p-6 flex flex-col items-center">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 w-full max-w-4xl">
              <h2 className="text-lg font-bold text-slate-800">World Taekwondo Team Standings Classification</h2>
              <button
                onClick={downloadOverallStandings}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl flex items-center gap-2 text-sm transition-all shadow-sm"
              >
                <Download size={16} />
                Download Standings CSV
              </button>
            </div>
            
            <div className="w-full max-w-4xl border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-900 text-white">
                    <th className="p-4 font-black tracking-widest text-sm uppercase">Rank</th>
                    <th className="p-4 font-black tracking-widest text-sm uppercase">Club / State</th>
                    <th className="p-4 font-black tracking-widest text-sm uppercase text-center text-yellow-400">Gold</th>
                    <th className="p-4 font-black tracking-widest text-sm uppercase text-center text-slate-300">Silver</th>
                    <th className="p-4 font-black tracking-widest text-sm uppercase text-center text-amber-600">Bronze</th>
                    <th className="p-4 font-black tracking-widest text-sm uppercase text-center bg-blue-600">Total Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {clubStandings.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-500">
                         {isLoading ? "Calculating team scores..." : "No club data parsed yet."}
                      </td>
                    </tr>
                  ) : clubStandings.map((c, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="p-4">
                        <div className={cn(
                          "w-8 h-8 rounded-full flex items-center justify-center font-black text-sm",
                          i === 0 ? "bg-yellow-400 text-yellow-900" :
                          i === 1 ? "bg-slate-300 text-slate-800" :
                          i === 2 ? "bg-amber-600 text-white" : "bg-slate-100 text-slate-600"
                        )}>
                          {i + 1}
                        </div>
                      </td>
                      <td className="p-4 font-bold text-blue-900 text-lg flex items-center gap-3">
                        <Building2 size={20} className="text-slate-400" />
                        {c.club || 'Unknown Club'}
                      </td>
                      <td className="p-4 font-black text-center text-lg">{c.gold}</td>
                      <td className="p-4 font-black text-center text-lg">{c.silver}</td>
                      <td className="p-4 font-black text-center text-lg">{c.bronze}</td>
                      <td className="p-4 font-black text-center text-xl text-blue-700 bg-blue-50/50">{c.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-8 text-sm text-slate-400 bg-slate-50 p-4 rounded-xl border border-slate-100 max-w-4xl">
              <strong>WT Calculation Rules Applied:</strong> Teams are ranked by Total Points (Gold: 7, Silver: 3, Bronze: 1). If there is a tie in points, the team with the most Gold medals wins, followed by Silver, then Bronze.
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
