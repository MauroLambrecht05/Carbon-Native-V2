export interface UploadedArtifact {
  readonly url: string;
}

export interface ArtifactUploader {
  upload(localPath: string, remoteKey: string): Promise<UploadedArtifact>;
}
