// Browser transport only. Reconnecting discards stale RFB decode queues, not
// the running editor, project, playback clock, background work or export job.
export const PREVIEW_PROFILES = Object.freeze({
  smooth: Object.freeze({ quality: 5, compression: 0 }),
  sharp: Object.freeze({ quality: 8, compression: 2 }),
});

export class PreviewConnection {
  constructor({ RFB, screen, url, onState, profile = 'smooth' }) {
    this.RFB = RFB;
    this.screen = screen;
    this.url = url;
    this.onState = onState;
    this.profile = Object.hasOwn(PREVIEW_PROFILES, profile) ? profile : 'smooth';
    this.current = null;
    this.suspended = false;
    this.disposed = false;
  }

  connect() {
    if (this.disposed || this.suspended || this.current) return;
    const host = this.screen.ownerDocument.createElement('div');
    host.className = 'vnc-session';
    this.screen.append(host);
    const rfb = new this.RFB(host, this.url);
    const session = { rfb, host };
    this.current = session;
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.clipViewport = false;
    this.applyProfile();
    session.connected = () => { if (this.current === session) this.onState('connected'); };
    session.disconnected = () => {
      if (this.current !== session) return;
      this.close();
      this.onState('disconnected');
    };
    rfb.addEventListener('connect', session.connected);
    rfb.addEventListener('disconnect', session.disconnected);
    this.onState('connecting');
  }

  applyProfile() {
    if (!this.current) return;
    const { quality, compression } = PREVIEW_PROFILES[this.profile];
    this.current.rfb.qualityLevel = quality;
    this.current.rfb.compressionLevel = compression;
  }

  setProfile(profile) {
    if (!Object.hasOwn(PREVIEW_PROFILES, profile)) return;
    this.profile = profile;
    this.applyProfile();
  }

  close() {
    const previous = this.current;
    this.current = null;
    if (!previous) return;
    previous.rfb.removeEventListener('connect', previous.connected);
    previous.rfb.removeEventListener('disconnect', previous.disconnected);
    previous.rfb.disconnect();
    previous.host.remove();
  }

  reconnect() { this.close(); this.connect(); }

  setVisible(visible) {
    if (this.disposed || this.suspended === !visible) return;
    this.suspended = !visible;
    if (visible) this.connect();
    else {
      this.close();
      this.onState('suspended');
    }
  }

  dispose() { this.disposed = true; this.close(); }
}
