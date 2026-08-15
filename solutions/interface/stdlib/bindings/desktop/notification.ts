// notification — a desktop toast through the OS notification centre.

declare const __cm_notification_send: (title: string, body: string, icon: string) => void;

export interface NotificationOptions {
  title: string;
  body: string;
  /** Path to an icon file on disk. Optional. */
  icon?: string;
}

export const notification = {
  send: (opts: NotificationOptions): void =>
    __cm_notification_send(opts.title, opts.body, opts.icon ?? ""),
};
