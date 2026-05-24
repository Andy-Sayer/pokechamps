// Barrel export for @pokechamps/core. Re-exports the most common modules so
// downstream packages (tui, server) can import from '@pokechamps/core' rather
// than deep paths. Deep paths still work via the './*' subpath export.
export * from './domain/types.js';
export * from './domain/data.js';
export * from './domain/predictions.js';
export * from './domain/speed.js';
export * from './domain/inference.js';
export * from './domain/scoutExport.js';
export * from './domain/turnparser.js';
export * from './domain/actionSuggest.js';
export * from './domain/pikalytics.js';
export * from './domain/pikalyticsFetch.js';
export * from './domain/hazards.js';
export * from './domain/fieldMoves.js';
export * from './domain/abilities.js';
export * from './domain/endOfTurn.js';
export * from './domain/bring.js';
export * from './domain/typechart.js';
export * from './domain/storage.js';
export * from './domain/damage.js';
export * from './domain/gimmicks/index.js';
export * from './match/engine.js';
export * from './storage/index.js';
