import { isBoutMatch } from './src/lib/utils.ts';
const matches = [
  { matchNoStr: 'C02', category: 'C0299 - POOMSAE', blueName: 'KANG', blueClub: 'MBW', redName: 'CHEAH', redClub: 'SMART', winner: 'CHEAH' },
  { matchNoStr: 'C03', category: 'C0299 - POOMSAE', blueName: 'TERRY', blueClub: 'MEM', redName: 'WINNER OF 2', redClub: '-', winner: 'TERRY' },
  { matchNoStr: 'C04', category: 'C0300 - POOMSAE', blueName: 'THOMAS', blueClub: 'SMART', redName: 'YAP', redClub: 'MEM', winner: 'THOMAS' },
  { matchNoStr: 'C05', category: 'C0300 - POOMSAE', blueName: 'HARVEY', blueClub: 'SMART', redName: 'TRISTAN', redClub: 'MBW', winner: 'TRISTAN' },
  { matchNoStr: 'C06', category: 'C0300 - POOMSAE', blueName: 'THOMAS', blueClub: 'SMART', redName: 'WINNER OF 5', redClub: '-', winner: 'THOMAS' }
];

const resolveParticipant = (name, fallbackClub, category, visited = new Set()) => {
  const trimmed = name.trim();
  const winMatch = trimmed.match(/^winner of\s+(.+)$/i);
  if (!winMatch) return { name: trimmed, club: fallbackClub };
  const sourceBoutStr = winMatch[1].trim();
  
  if (visited.has(sourceBoutStr)) return { name: trimmed, club: fallbackClub };
  visited.add(sourceBoutStr);

  const sourceMatch = matches.find(m => m.category === category && isBoutMatch(m.matchNoStr, sourceBoutStr));
  if (!sourceMatch || !sourceMatch.winner || sourceMatch.winner === '-') {
    return { name: trimmed, club: fallbackClub };
  }

  const sWinnerLower = sourceMatch.winner.trim().toLowerCase();
  const isSBlue = sWinnerLower === sourceMatch.blueName.toLowerCase() || 
                  sWinnerLower === 'winner blue' || sWinnerLower === 'blue' || sWinnerLower === 'completed';
  const isSRed = sWinnerLower === sourceMatch.redName.toLowerCase() || 
                 sWinnerLower === 'winner red' || sWinnerLower === 'red';

  if (isSBlue) {
    return resolveParticipant(sourceMatch.blueName, sourceMatch.blueClub, category, visited);
  } else if (isSRed) {
    return resolveParticipant(sourceMatch.redName, sourceMatch.redClub, category, visited);
  } else {
    if (sourceMatch.blueName.toLowerCase().includes(sWinnerLower)) {
       return resolveParticipant(sourceMatch.blueName, sourceMatch.blueClub, category, visited);
    }
    if (sourceMatch.redName.toLowerCase().includes(sWinnerLower)) {
       return resolveParticipant(sourceMatch.redName, sourceMatch.redClub, category, visited);
    }
    return { name: sourceMatch.winner, club: fallbackClub };
  }
};

const resolvedMatches = matches.map(m => {
   const blueResolved = resolveParticipant(m.blueName, m.blueClub, m.category, new Set());
   const redResolved = resolveParticipant(m.redName, m.redClub, m.category, new Set());
   const winnerResolved = resolveParticipant(m.winner, '', m.category, new Set());

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
console.log(resolvedMatches);
