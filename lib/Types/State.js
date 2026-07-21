import { Boom } from '@hapi/boom';
export var SyncState;
(function (SyncState) {
  SyncState[SyncState["Connecting"] = 0] = "Connecting";
  SyncState[SyncState["AwaitingInitialSync"] = 1] = "AwaitingInitialSync";
  SyncState[SyncState["Syncing"] = 2] = "Syncing";
  SyncState[SyncState["Online"] = 3] = "Online";
})(SyncState || (SyncState = {}));
