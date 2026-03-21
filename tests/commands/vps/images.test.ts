import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
vi.mock('../../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet }),
  },
}));

const { imagesCommand } = await import('../../../src/commands/vps/images.js');

describe('vps images', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('displays grouped images', async () => {
    mockGet.mockResolvedValue({
      groups: [
        {
          distro: 'ubuntu', name: 'Ubuntu',
          images: [
            { id: 'ubuntu-24.04', image: 'registry/ubuntu:24.04', label: 'Ubuntu 24.04 LTS', description: 'Latest LTS', version: '24.04', family: 'debian', default_user: 'root' },
            { id: 'ubuntu-22.04', image: 'registry/ubuntu:22.04', label: 'Ubuntu 22.04 LTS', description: 'Previous LTS', version: '22.04', family: 'debian', default_user: 'root' },
          ],
        },
        {
          distro: 'debian', name: 'Debian',
          images: [
            { id: 'debian-12', image: 'registry/debian:12', label: 'Debian 12 Bookworm', description: 'Stable', version: '12', family: 'debian', default_user: 'root' },
          ],
        },
      ],
    });

    await imagesCommand.parseAsync(['node', 'test']);

    expect(mockGet).toHaveBeenCalledWith('/api/v1/vps/images/grouped');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Ubuntu'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('ubuntu-24.04'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Debian'));
  });
});
