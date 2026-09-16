import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockDelete = vi.fn();
vi.mock('../../src/lib/api-client.js', () => ({
  ApiClient: {
    create: () => Promise.resolve({ get: mockGet, delete: mockDelete }),
  },
}));

const { registryCommand } = await import('../../src/commands/registry/index.js');
const { ApiError } = await import('../../src/lib/errors.js');

const REPO = {
  id: '01a082d0-975d-70a0-aecd-2740713017e4',
  path: 'acme/web',
  tag_count: 3,
  created_at: '2026-09-08T20:58:23Z',
};

const IN_USE_MESSAGE =
  "Tag 'v1' is deployed by serverless container(s) web (running). Deleting the image would break their next start; redeploy or remove the container first, or pass force=true to delete it anyway.";

/**
 * The 2026-09-16 shape: a CI "keep the newest N tags" step deleted the tag the
 * live container was deployed from. The API now refuses with 409 unless told
 * `force`; the CLI must surface who depends on the image and which flag is
 * the deliberate override. `--force` alone only skips the prompt.
 *
 * Commander keeps parsed option values on the command between parses, so the
 * case that asserts a bare path runs first.
 */
describe('registry repos rm-tag / rm', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGet.mockReset();
    mockDelete.mockReset();
    mockGet.mockResolvedValue({ data: [REPO], pagination: { last_page: 1, total: 1 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an in-use refusal with the container name and the override flag', async () => {
    mockDelete.mockRejectedValue(new ApiError(409, IN_USE_MESSAGE, undefined, { code: 'image_in_use' }));

    await expect(
      registryCommand.parseAsync(['node', 'test', 'repos', 'rm-tag', 'acme/web', 'v1', '--force']),
    ).rejects.toThrow('deployed by serverless container(s) web (running)');

    expect(mockDelete).toHaveBeenCalledWith(`/api/v1/registry/repositories/${REPO.id}/tags/v1`);
    const printed = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('web (running)');
    expect(printed).toContain('--delete-in-use');
  });

  it('still reports the retryable 503 refusal', async () => {
    mockDelete.mockRejectedValue(
      new ApiError(503, 'The registry did not confirm the delete, so nothing was removed.'),
    );

    await expect(
      registryCommand.parseAsync(['node', 'test', 'repos', 'rm-tag', 'acme/web', 'v1', '--force']),
    ).rejects.toThrow();

    const printed = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('retryable');
  });

  it('passes force=1 to the API with --delete-in-use', async () => {
    mockDelete.mockResolvedValue({ message: "Tag 'v1' deleted" });

    await registryCommand.parseAsync([
      'node', 'test', 'repos', 'rm-tag', 'acme/web', 'v1', '--force', '--delete-in-use',
    ]);

    expect(mockDelete).toHaveBeenCalledWith(`/api/v1/registry/repositories/${REPO.id}/tags/v1?force=1`);
  });

  it('passes force=1 when deleting a whole repository with --delete-in-use', async () => {
    mockDelete.mockResolvedValue({ message: 'deleted' });

    await registryCommand.parseAsync(['node', 'test', 'repos', 'rm', 'acme/web', '--force', '--delete-in-use']);

    expect(mockDelete).toHaveBeenCalledWith(`/api/v1/registry/repositories/${REPO.id}?force=1`);
  });
});
