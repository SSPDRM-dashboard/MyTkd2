import { ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatIC(ic: string): string {
  // Malaysian IC format: YYMMDD-PB-###G
  const cleaned = ic.replace(/\D/g, '');
  if (cleaned.length !== 12) return ic;
  return `${cleaned.slice(0, 6)}-${cleaned.slice(6, 8)}-${cleaned.slice(8)}`;
}

export function validateIC(ic: string): boolean {
  const cleaned = ic.replace(/\D/g, '');
  return cleaned.length === 12;
}

export function parseRingNumber(ringVal: any): number {
  if (!ringVal) return 1;
  const s = ringVal.toString().trim().toUpperCase();
  
  // 1. Check for court/ring keyword followed by number or letter (e.g., "RING 3", "COURT B")
  const keywordMatch = s.match(/(?:RING|COURT|AISTUDIO)\s*([A-Z0-9]+)/i);
  if (keywordMatch && keywordMatch[1]) {
    const val = keywordMatch[1].trim();
    if (/^\d+$/.test(val)) {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num > 0) return num;
    }
    if (/^[A-Z]$/.test(val)) {
      return val.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
    }
  }

  // 2. If it's a full alphanumeric bout code (e.g., "F01", "F22B", "A15")
  const boutMatch = s.match(/^([A-Z])(\d+)([A-Z]*)$/);
  if (boutMatch) {
    return boutMatch[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1;
  }

  // 3. Fallback to extracting stable standalone numbers or trailing numbers
  const trailingNum = s.match(/\b\d+\b/) || s.match(/\d+/);
  if (trailingNum) {
    const num = parseInt(trailingNum[0], 10);
    if (!isNaN(num) && num > 0) return num;
  }

  // 4. Look for single letter (e.g. "A", "B", "C")
  const singleLetterMatch = s.match(/\b([A-Z])\b/) || s.match(/^([A-Z])$/);
  if (singleLetterMatch && singleLetterMatch[1]) {
    return singleLetterMatch[1].charCodeAt(0) - 'A'.charCodeAt(0) + 1;
  }

  return 1;
}

export function normalizeBoutNumber(bout: string | number): string {
  let s = bout.toString().replace(/\s+/g, '').toUpperCase();
  if (!s) return '';
  
  // Replace letter 'O' with digit '0' if it is inside the alphabetic ring prefix of a bout (e.g., "CO1" -> "C01")
  s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
  
  // Handle A01, B01, C01 format (A=1000, B=2000, C=3000, etc.) with optional suffix
  const match = s.match(/^([A-Z])(\d+)([A-Z]*)$/);
  if (match) {
    const letter = match[1];
    const number = parseInt(match[2]);
    const suffix = match[3] || '';
    const ringOffset = (letter.charCodeAt(0) - 'A'.charCodeAt(0) + 1) * 1000;
    return (ringOffset + number).toString() + suffix;
  }
  
  // Handle cases where someone might input "1022" and we want to compare with "1022"
  return s;
}

export function isBoutMatch(bout1: string | number, bout2: string | number): boolean {
  if (bout1 === bout2) return true;
  if (!bout1 || !bout2) return false;

  const getSuffix = (b: string | number): string => {
    const s = b.toString().toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    const match = s.match(/([0-9]+)([A-Z]+)$/);
    return match ? match[2] : '';
  };

  const suffix1 = getSuffix(bout1);
  const suffix2 = getSuffix(bout2);

  if (suffix1 !== suffix2) return false;

  const normalizeLenient = (b: string | number) => {
    let s = b.toString().toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    // Also cover lenient "O" to "0" replacing for single letter prefixes
    s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
    return s;
  };
  
  const b1 = normalizeLenient(bout1);
  const b2 = normalizeLenient(bout2);
  
  if (b1 === b2) return true;
  
  const norm1 = normalizeBoutNumber(bout1);
  const norm2 = normalizeBoutNumber(bout2);
  
  if (norm1 === norm2) return true;
  
  // Also check if one is relative (e.g. "22") and the other is absolute (e.g. "1022")
  const num1 = parseInt(norm1.replace(/[^0-9]/g, ''));
  const num2 = parseInt(norm2.replace(/[^0-9]/g, ''));
  
  if (!isNaN(num1) && !isNaN(num2)) {
    if (num1 === num2) return true;

    // If both specify a ring (>= 1000), they MUST be in the exact same ring to match.
    // This prevents "B12" (2012) from matching "A12" (1012).
    if (num1 >= 1000 && num2 >= 1000) {
      const ring1 = Math.floor(num1 / 1000);
      const ring2 = Math.floor(num2 / 1000);
      if (ring1 !== ring2) {
        return false;
      }
      return num1 % 1000 === num2 % 1000;
    }
    
    // If one is < 1000 and the other is exactly (Ring * 1000) + that number
    if (num1 < 1000 && num2 >= 1000 && num2 % 1000 === num1) return true;
    if (num2 < 1000 && num1 >= 1000 && num1 % 1000 === num2) return true;
  }
  
  return false;
}

export function normalizeBoutWithRing(bout: string | number, ringNum: number, originalRingNum?: number): string {
  let s = bout.toString().replace(/\s+/g, '').toUpperCase();
  if (!s) return '';
  
  // Normalize O to 0
  s = s.replace(/^([A-H])O+(\d+)([A-Z]*)$/, '$10$2$3');
  
  // Align letters to the current ring's expected letter prefix if they don't match
  if (ringNum >= 1 && ringNum <= 12) {
    const expectedPrefix = String.fromCharCode(64 + ringNum);
    const letterPrefixMatch = s.match(/^([A-Z])(\d+)([A-Z]*)$/);
    if (letterPrefixMatch) {
      const currentPrefix = letterPrefixMatch[1];
      if (currentPrefix !== expectedPrefix) {
        // Calculate the original ring from prefix 'currentPrefix'
        const origRingFromPrefix = currentPrefix.charCodeAt(0) - 64;
        const isKnownTransfer = (origRingFromPrefix >= 1 && origRingFromPrefix <= 12) || (originalRingNum && originalRingNum !== ringNum);
        
        if (isKnownTransfer) {
          // This is a transferred bout! DO NOT change its prefix to the current ring's prefix.
          return normalizeBoutNumber(s);
        }
        
        // Correct prefix to align with expected letter prefix (e.g., B03 -> D03 in Ring 4)
        s = expectedPrefix + s.substring(1);
      }
    }
  }
  
  // If it already has a letter, use standard normalization
  if (/^[A-Z]/.test(s)) return normalizeBoutNumber(s);
  
  const num = parseInt(s.replace(/[^0-9]/g, ''));
  if (isNaN(num)) return s;

  // Extract suffix
  const suffixMatch = s.match(/([0-9]+)([A-Z]+)$/);
  const suffix = suffixMatch ? suffixMatch[2] : '';
  
  // If it's a small number, assume it's relative to the ring
  if (num < 1000) {
    return ((ringNum * 1000) + num).toString() + suffix;
  }
  
  return num.toString() + suffix;
}

export function getBoutNumber(bout: string | number): number {
  return parseInt(normalizeBoutNumber(bout)) || 0;
}

export function formatBoutNumber(ringNum: number, bout: string | number, mode: 'numeric' | 'alphanumeric' = 'alphanumeric'): string {
  const s = bout.toString().replace(/\s+/g, '').toUpperCase();
  if (!s) return '';

  const num = parseInt(s.replace(/[^0-9]/g, ''));
  
  // Extract custom suffix using safe pattern
  const match = s.match(/([0-9]+)([A-Z]+)$/);
  const suffix = match ? match[2] : '';

  if (isNaN(num)) return s;

  if (mode === 'numeric') {
    // If it's alphanumeric (e.g., A01), convert to numeric (1001)
    if (/^[A-Z]/.test(s)) {
      const letter = s.charAt(0);
      const ring = letter.charCodeAt(0) - 64;
      const boutNum = parseInt(s.substring(1).replace(/[^0-9]/g, ''));
      return ((ring * 1000) + boutNum).toString() + suffix;
    }
    
    // If it's a small number, add ring offset
    if (num < 1000 && ringNum > 0) {
      return ((ringNum * 1000) + num).toString() + suffix;
    }
    return num.toString() + suffix;
  }

  // Alphanumeric mode (A01)
  // 1. If it already has a letter prefix (e.g., A01), keep it
  if (/^[A-Z]/.test(s)) return s;

  // 2. If it's a "full" numeric ID (>= 1000), convert it back to letter format
  if (num >= 1000) {
    const ring = Math.floor(num / 1000);
    const boutInRing = num % 1000;
    const letter = String.fromCharCode(64 + ring);
    return `${letter}${boutInRing.toString().padStart(2, '0')}${suffix}`;
  }

  // 3. For small numbers (e.g., "1"), default to the letter format (e.g., "A01")
  const letter = String.fromCharCode(64 + ringNum);
  return `${letter}${num.toString().padStart(2, '0')}${suffix}`;
}

/**
 * Detects if the event data is using the A01 format.
 * If any bout in the queue or rings starts with a letter, we assume A01 method.
 */
export function isUsingA01Method(data: any[]): boolean {
  return data.some(item => {
    const bout = item.data?.bout || item.bout || '';
    return /^[A-Z]/.test(bout.toString().trim().toUpperCase());
  });
}

export function extractWinnerOfBout(nameStr: string | null | undefined): string | null {
  if (!nameStr) return null;
  let s = nameStr.trim().toUpperCase();
  
  // Normalize variations of WINNER OF BOUT / WINNER OF MATCH / WINNER BOUT / WINNER
  s = s.replace(/\b(?:WINNER|WINN|WINNR)\s+(?:OF\s+)?(?:BOUT\s+|MATCH\s+)?/i, 'WINNER OF ');
  
  // Clean letter 'O' vs number '0' typos inside alphabetic ring prefix of a bout code (e.g., "C O1" -> "C01", "CO1" -> "C01")
  s = s.replace(/([A-H])\s*O\s*(\d+)/g, '$10$2');
  
  // Clean spaced bout numbers (e.g., "C 01" -> "C01")
  s = s.replace(/([A-H])\s*(\d+)/g, '$1$2');

  // Remove space between digits and a trailing suffix alphabet, e.g., "F22 B" -> "F22B", "22 b" -> "22B"
  s = s.replace(/(\d+)\s*([A-Z]+)\b/g, '$1$2');

  // Perform extracting match
  const matchOf = s.match(/WINNER OF\s*([\w-]+)/i);
  if (matchOf && matchOf[1]) {
    let extracted = matchOf[1].trim();
    // Normalize "O" to "0" one more time inside extracted bout
    if (/^[A-H]O+\d+$/.test(extracted)) {
      extracted = extracted.charAt(0) + extracted.substring(1).replace(/O/g, '0');
    }
    return extracted;
  }
  
  return null;
}

export function getEventSpreadsheetUrl(event?: { sheetUrl?: string, winnerSheetUrl?: string }): string | null {
  if (!event) return null;
  if (event.winnerSheetUrl && event.winnerSheetUrl.includes('docs.google.com/spreadsheets')) {
    return event.winnerSheetUrl;
  }
  if (event.sheetUrl && event.sheetUrl.includes('docs.google.com/spreadsheets')) {
    return event.sheetUrl;
  }
  return null;
}

export function getEventWebAppUrl(event?: { sheetUrl?: string, winnerSheetUrl?: string }, fallbackUrl: string = ''): string {
  if (!event) return fallbackUrl;
  
  // Prefer any URL that explicitly mentions script.google.com or /exec
  if (event.sheetUrl && (event.sheetUrl.includes('script.google.com') || event.sheetUrl.includes('/exec'))) {
    return event.sheetUrl;
  }
  if (event.winnerSheetUrl && (event.winnerSheetUrl.includes('script.google.com') || event.winnerSheetUrl.includes('/exec'))) {
    return event.winnerSheetUrl;
  }
  
  // Fallback signature checks
  if (event.sheetUrl && !event.sheetUrl.includes('docs.google.com/spreadsheets')) {
    return event.sheetUrl;
  }
  if (event.winnerSheetUrl && !event.winnerSheetUrl.includes('docs.google.com/spreadsheets')) {
    return event.winnerSheetUrl;
  }
  
  return fallbackUrl;
}


