// Vision data model. The pipeline is:
//   Frame → (RegionMap) → FrameRead → (BattleStateMachine) → TurnObservation
//        → (emitTurnLog) → TurnProposal → [confirm in TUI] → existing parser/engine
// Everything downstream of TurnProposal already exists; the vision layer only has
// to produce parser-compatible turn-log strings.

/** A captured frame, RGBA pixels row-major (length = width*height*4). */
export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Capture timestamp (ms). */
  ts: number;
}

/** A rectangle in NORMALIZED coordinates [0,1] — resolution-independent, resolved
 *  to pixels per frame. Keeps one RegionMap valid across 720p/1080p/4K capture. */
export interface Rect { x: number; y: number; w: number; h: number; }

/** One active-mon slot's on-screen anchors (doubles: 2 mine + 2 opp). */
export interface SlotRegion {
  side: 'mine' | 'opp';
  index: 0 | 1;
  name: Rect;        // the species/nickname label
  hpBar: Rect;       // the HP bar fill
  statusIcon: Rect;  // brn/par/slp/… badge
}

/** The fixed screen layout for one battle UI. Calibrated from real screenshots. */
export interface RegionMap {
  label: string;            // e.g. 'champions-doubles-1080p'
  battleText: Rect;         // bottom log box ("X used Y!", "…fainted!")
  moveMenu: [Rect, Rect, Rect, Rect];  // 4 move slots (when choosing)
  slots: SlotRegion[];      // 4 in doubles
  /** The two opponent HP-percent readouts (white digits on the nameplate bar), left
   *  plate → o1, right → o2. OCR'd for the exact remaining HP% (the inference signal). */
  oppHpText?: [Rect, Rect];
  /** My two HP readouts — ABSOLUTE "cur/max" digits on the bottom nameplates (m1, m2).
   *  OCR'd for exact current HP (mine shows absolute, opponents show percent). */
  myHpText?: [Rect, Rect];
}

/** Active-slot refs as the turn-log grammar uses them. */
export type SlotRef = 'm1' | 'm2' | 'o1' | 'o2';

/** What one frame yields per active slot after reading its regions. */
export interface SlotRead {
  side: 'mine' | 'opp';
  index: 0 | 1;
  species: string | null;       // resolved to a legal species, or null if unsure
  speciesRaw: string;           // raw OCR text
  speciesConfidence: number;    // 0..1
  hpFraction: number | null;    // 0..1 from the bar, or null if unreadable
  /** Mine-side ONLY: the exact current HP as written on the nameplate ("117/175" → 117).
   *  This is what the turn-log must carry for m-slots — a human keys in the on-screen
   *  raw value, never a percent. Null when the digits didn't resolve (bar-only read). */
  hpRaw?: number | null;
  status: string | null;        // 'brn' | 'par' | … | null
}

/** One frame fully read. */
export interface FrameRead {
  ts: number;
  slots: SlotRead[];
  battleText: string;   // OCR of the log box
}

/** One assembled action within a turn (mirrors the turn-log verbs). */
export interface TurnAction {
  actor: SlotRef;
  kind: 'move' | 'switch';
  move?: string;
  target?: SlotRef;                                   // single-target move
  hpRemainingPercent?: number;                        // target HP% after the hit
  hpRemainingRaw?: number;                            // mine-side target: exact on-screen HP (emit takes precedence)
  spread?: { ref: SlotRef; hpRemainingPercent: number; hpRemainingRaw?: number }[]; // spread move
  switchTo?: string;                                  // species (switch)
  mega?: boolean;
  crit?: boolean;
}

/** A complete turn the state machine has decided is settled. */
export interface TurnObservation {
  actions: TurnAction[];
  faints: SlotRef[];
  megas?: SlotRef[];    // mons that Mega-Evolved but whose MOVE wasn't captured (→ standalone mega line)
  stateLines?: string[]; // state updates (stat boosts — Intimidate, Nasty Plot, …) as turn-log lines
  confidence: number;   // min over the reads that fed it
  notes: string[];      // human-readable caveats ("HP bar mid-animation", …)
}

/** What the VisionSource hands the TUI for confirm/edit before committing. */
export interface TurnProposal {
  lines: string[];      // canonical turn-log lines, ready for the parser
  confidence: number;
  notes: string[];
  frameTs: number;
  partial?: boolean;    // an in-progress (not-yet-closed) turn — a LIVE PREVIEW so the user
                        // sees the reader capturing and knows not to type; not yet ratifiable.
}

/** The team-preview ("Select 4") screen: YOUR six on the left as TEXT (name +
 *  item → OCR), the OPPONENT's six on the right as SPRITES only (→ sprite match),
 *  with the trainer name as the only opponent text. A different layout from the
 *  in-battle RegionMap. Coordinates NORMALIZED to the 16:9 game frame. */
export interface TeamPreviewRegions {
  label: string;
  myTeam: { name: Rect; item: Rect }[];   // left panel, 6 rows — OCR
  oppTeam: { sprite: Rect }[];             // right panel, 6 rows — sprite match
  oppName: Rect;                           // opponent trainer name — OCR
}
