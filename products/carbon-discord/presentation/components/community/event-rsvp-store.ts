// Tracks event RSVPs in memory.

export class EventRsvpStore {
  private static instance: EventRsvpStore;
  private readonly events = new Map<string, Set<string>>();

  static getInstance(): EventRsvpStore {
    if (!EventRsvpStore.instance) {
      EventRsvpStore.instance = new EventRsvpStore();
    }
    return EventRsvpStore.instance;
  }

  toggleRsvp(
    eventId: string,
    userId: string,
  ): { attending: boolean; total: number; attendees: string[] } {
    let attendees = this.events.get(eventId);
    if (!attendees) {
      attendees = new Set<string>();
      this.events.set(eventId, attendees);
    }

    let attending = false;
    if (attendees.has(userId)) {
      attendees.delete(userId);
      attending = false;
    } else {
      attendees.add(userId);
      attending = true;
    }

    return {
      attending,
      total: attendees.size,
      attendees: Array.from(attendees),
    };
  }

  getAttendees(eventId: string): string[] {
    const attendees = this.events.get(eventId);
    return attendees ? Array.from(attendees) : [];
  }

  clear(): void {
    this.events.clear();
  }
}
