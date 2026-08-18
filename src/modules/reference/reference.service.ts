import {
  PACKAGE_TYPE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_TYPE_LABELS,
  asOptions,
} from '../../constants/enums.js';
import * as repo from './reference.repository.js';

/** Everything the consignment form needs to populate its dropdowns. */
export async function getReference() {
  const [clients, drivers] = await Promise.all([
    repo.findActiveClients(),
    repo.findActiveDrivers(),
  ]);

  return {
    clients,
    drivers,
    statuses: asOptions(STATUS_LABELS),
    priorities: asOptions(PRIORITY_LABELS),
    taskTypes: asOptions(TASK_TYPE_LABELS),
    packageTypes: asOptions(PACKAGE_TYPE_LABELS),
  };
}
