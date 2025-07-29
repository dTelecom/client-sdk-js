import log from '../logger';

export class FallbackUrlProvider {
  private fallbackUrls?: string[]

  private attemptedUrls: string[] = [];

  constructor(fallbackUrls: string[]) {
    this.fallbackUrls = fallbackUrls
  }

  isAvailable() {
    return this.fallbackUrls && this.fallbackUrls.length > 0
  }

  getNextUrl() {
    if (!this.isAvailable()) {
      throw Error('no fallback urls proviced');
    }
    const urlsLeft = this.fallbackUrls?.filter(
      (url) => !this.attemptedUrls.find((attempted) => attempted === url),
    );
    if (urlsLeft && urlsLeft.length > 0) {
      const nextUrl = urlsLeft[0];
      this.attemptedUrls.push(nextUrl);
      log.debug(`next url: ${nextUrl}`);
      return nextUrl;
    } else {
      return null;
    }
  }

  resetAttempts() {
    this.attemptedUrls = [];
  }
}
