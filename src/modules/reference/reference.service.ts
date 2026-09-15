import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_TYPE_LABELS,
  asOptions,
} from '../../constants/enums.js';
import * as repo from './reference.repository.js';

/** Everything the consignment form needs to populate its dropdowns. */
export async function getReference() {
  const [clients, drivers, serviceLevels] = await Promise.all([
    repo.findActiveClients(),
    repo.findActiveDrivers(),
    repo.findActiveServiceLevels(),
  ]);

  return {
    clients,
    drivers,
    serviceLevels,
    statuses: asOptions(STATUS_LABELS),
    priorities: asOptions(PRIORITY_LABELS),
    taskTypes: asOptions(TASK_TYPE_LABELS),
  };
}
