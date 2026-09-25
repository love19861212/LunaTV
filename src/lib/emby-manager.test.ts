jest.mock('./config', () => ({
  getConfig: jest.fn(),
}));

jest.mock('./db', () => ({
  dbManager: {
    getUserEmbyConfig: jest.fn().mockResolvedValue({ sources: [] }),
  },
}));

import { getConfig } from './config';
import { embyManager } from './emby-manager';

describe('EmbyManager client configuration cache', () => {
  beforeEach(() => {
    embyManager.clearCache();
    embyManager.clearUserCache();
    jest.clearAllMocks();
  });

  it('rebuilds a cached public-source client when transcode settings change', async () => {
    const source = {
      key: 'public-emby',
      name: 'Public Emby',
      enabled: true,
      isPublic: true,
      ServerURL: 'https://emby.example.test',
      ApiKey: 'test-token',
      UserId: 'test-user',
      transcodeMp4: false,
    };
    (getConfig as jest.Mock).mockResolvedValue({ EmbyConfig: { Sources: [source] } });

    const directClient = await embyManager.getClientForUser('viewer', source.key);
    const directUrl = await directClient.getStreamUrl('item-1');
    expect(directUrl).toContain('/stream?static=true');

    (getConfig as jest.Mock).mockResolvedValue({
      EmbyConfig: { Sources: [{ ...source, transcodeMp4: true }] },
    });

    const transcodingClient = await embyManager.getClientForUser('viewer', source.key);
    const transcodingUrl = await transcodingClient.getStreamUrl('item-1');
    expect(transcodingUrl).toContain('/master.m3u8?');
    expect(transcodingUrl).toContain('AudioCodec=aac');
  });
});
