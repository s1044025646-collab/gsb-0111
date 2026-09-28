import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';
import { Repository } from './repository.js';
import { associateObservations } from './association.js';
import { locate, type LocationObservation } from './location.js';
import type { Clock } from './time.js';

export class SeismicService {
  readonly repo: Repository;
  constructor(readonly db: DatabaseSync, clock: Clock) {
    this.repo = new Repository(db, clock);
  }

  associateAndLocate(modelId?: number, publish = false) {
    return transaction(this.db, () => {
      const model = modelId === undefined ? this.repo.currentModel() : this.repo.getModel(modelId);
      const observations = this.repo.activeObservations(model.id) as unknown as LocationObservation[];
      const association = associateObservations(observations);
      const usedPicks = new Set<number>();
      for (const row of this.db.prepare('SELECT pick_id AS pickId FROM event_picks').all() as Array<{ pickId: number }>) usedPicks.add(row.pickId);
      const created: number[] = [];
      const rejectedGroups = association.rejected;
      for (const pickIds of association.groups) {
        const already = pickIds.every((pickId) => usedPicks.has(pickId));
        if (already) continue;
        const eventId = this.repo.createEvent(pickIds);
        created.push(eventId);
        const pickIdSet = new Set(pickIds);
        const input = observations.filter((item) => pickIdSet.has(item.pickId));
        const result = locate(input);
        const snapshot = { modelId: model.id, observations: input };
        this.repo.saveSolution({
          eventId,
          modelId: model.id,
          originTimeMs: result.originTimeMs,
          eastKm: result.eastKm,
          northKm: result.northKm,
          depthKm: result.depthKm,
          covariance: result.covariance,
          rmsResidualSec: result.rmsResidualSec,
          maxAbsResidualSec: result.maxAbsResidualSec,
          status: result.status,
          rejectionReason: result.rejectionReason ?? '',
          inputSnapshot: snapshot,
          inputHash: this.repo.snapshotHash(snapshot),
          iterations: result.iterations,
          published: publish && result.status === 'accepted',
        });
        if (result.status === 'accepted') this.repo.setEventStatus(eventId, 'located');
        else this.repo.setEventStatus(eventId, 'rejected');
      }
      return { createdEventIds: created, rejectedGroups };
    });
  }

  relocatEvent(eventId: number, modelId?: number, publish = false) {
    return transaction(this.db, () => {
      const model = modelId === undefined ? this.repo.currentModel() : this.repo.getModel(modelId);
      const pickRows = this.repo.eventPicks(eventId) as Array<{ pickId: number }>;
      const pickIds = new Set(pickRows.map((row) => row.pickId));
      const observations = this.repo.activeObservations(model.id).filter((item) => pickIds.has((item as unknown as { pickId: number }).pickId)) as unknown as LocationObservation[];
      const result = locate(observations);
      const snapshot = { modelId: model.id, observations };
      const solutionId = this.repo.saveSolution({
        eventId, modelId: model.id, originTimeMs: result.originTimeMs, eastKm: result.eastKm, northKm: result.northKm, depthKm: result.depthKm,
        covariance: result.covariance, rmsResidualSec: result.rmsResidualSec, maxAbsResidualSec: result.maxAbsResidualSec,
        status: result.status, rejectionReason: result.rejectionReason ?? '', inputSnapshot: snapshot,
        inputHash: this.repo.snapshotHash(snapshot), iterations: result.iterations, published: publish && result.status === 'accepted',
      });
      this.repo.setEventStatus(eventId, result.status === 'accepted' ? (publish ? 'located' : 'located') : 'rejected');
      return { solutionId, ...result };
    });
  }

  replaySolution(solutionId: number) {
    const row = this.db.prepare('SELECT * FROM location_solutions WHERE id = ?').get(solutionId) as { input_snapshot_json: string; rejection_reason: string } | undefined;
    if (!row) throw Object.assign(new Error('solution not found'), { code: 'NOT_FOUND' });
    const snapshot = JSON.parse(row.input_snapshot_json) as { modelId: number; observations: LocationObservation[] };
    const result = locate(snapshot.observations);
    return { replayMatches: !result.rejectionReason || result.rejectionReason === row.rejection_reason, snapshot, result };
  }
}
