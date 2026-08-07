// @carbon/updates — keeping an installed app current without bricking it.
//
//   domain/          the A/B slot state machine, rollout bucketing, the yank list
//   application/     apply an update; handle a crash loop
//   ports/           ArtifactSource — where update bytes come from
//   infrastructure/  the file-backed slot state and the HTTP source

export { SlotState, type SlotStateData } from "./domain/entities/SlotState.ts";
export { inRollout } from "./domain/services/RolloutService.ts";
export { StopList, isYanked, type YankedEntry, type StopListData } from "./domain/value-objects/StopList.ts";
export type { SlotStateRepository } from "./domain/repositories/SlotStateRepository.ts";
export type { ArtifactSource, FetchedArtifact } from "./application/ports/ArtifactSource.ts";
export { promoteStaging, applyUpdate } from "./application/usecases/ApplyUpdateUseCase.ts";
export { handleCrashDetection } from "./application/usecases/HandleCrashUseCase.ts";
export { FileSlotStateRepository, STATE_FILENAME } from "./infrastructure/FileSlotStateRepository.ts";
export { downloadUpdate, downloadUpdateOverHttp, verifyFile as verifyArtifactHash, type DownloadResult } from "./infrastructure/HttpArtifactSource.ts";
