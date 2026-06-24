# Tournament Placement Guidelines

These guidelines define how placements (1st, 2nd, 3rd, 4th) are determined from the bout chart.

## 1. The Final Match (The Last Bout)
The final match determines the top two spots:
- **1st Place (Gold)**: The Winner of the final bout.
- **2nd Place (Silver)**: The Loser of the final bout.

## 2. The Semi-Final Matches
This is where the 3rd and 4th places are decided. There are two standard ways to do this:

### Option A: Joint 3rd Place (Most Common in WT)
In most Taekwondo tournaments, there is no "3rd place match."
- **3rd Place**: Both players who lost in the Semi-Finals are awarded 3rd place.
- **System Logic**: Look at the two bouts immediately preceding the Final. The losers of those two matches are the 3rd place winners.

### Option B: Third-Place Playoff
If the specific tournament requires a 4th place ranking:
- **3rd Place**: The Winner of the "Bronze Medal Match" (played between the two Semi-Final losers).
- **4th Place**: The Loser of that same "Bronze Medal Match."

## Logic for AI Prompting & Results Processing
- **Identify Final**: Find by category and the match with the highest `bout_number`.
- **Assign 1st/2nd**: Winner = 1st, Loser = 2nd.
- **Identify Semi-Finals**: Find the two matches that fed into the Final.
- **Assign 3rd/4th**:
    - If `third_place_match` exists: Winner = 3rd, Loser = 4th.
    - If not: Both Losers = 3rd.

## Match Numbering Data Rule & Three-Part Composite ID Standard
When processing tournament queries, remember that MATCH = BOUT.
Match numbers (e.g., "E09", "B14") are NOT unique on their own. They reset and duplicate across different Event Names and different Dates. "Match 1" or "Bout E09" in one event is completely unrelated to "Match 1" or "Bout E09" in another event.

### CRITICAL DATA SEPARATION RULE:
1. Every single match must be identified internally by combining the [Date], the [Event Name], and the [Bout Number].
   - Example Formula: `Date_EventName_BoutNumber`
   - Example: "2026-06-16_Event A_E09" is treated as completely independent and separate from "2026-06-17_Event A_E09" or "2026-06-16_Event B_E09".

2. When the system or a user requests an update (such as updating a winner or a club name), you must explicitly verify all three criteria—the Date, the Event Name, and the Bout Number—before modifying any values. Never update a bout based on the bout number alone.

3. If data is received or queried without explicit Date and Event Name context, DO NOT guess or apply changes blindly. Immediately halt the process and respond with: "ERROR: Missing Date or Event Name context for unique bout identification."

4. Treat every combination of Date and Event Name as isolated data capsules. Match histories, athlete rosters, and bout queues must never bleed across different days or different events, even if the match codes look identical.

## 3. Event Management and Administrative Rules
- **Explicit Permission Prior to Changes**: The system and agent MUST explicitly ask the user for permission and confirm details before executing any code changes, state updates, or database adjustments concerning active tournament events, current configurations, or active logic.



