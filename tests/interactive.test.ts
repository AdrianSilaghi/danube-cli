import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConfirm = vi.fn();
vi.mock('@inquirer/prompts', () => ({ confirm: (...a: unknown[]) => mockConfirm(...a) }));

const { canPrompt, promptOr, confirmDestruction } = await import('../src/lib/interactive.js');
const { setJsonMode } = await import('../src/lib/json-mode.js');
const { MissingFlagsError, ConfirmationRequiredError } = await import('../src/lib/errors.js');

describe('interactive guards', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => { setJsonMode(false); Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true }); mockConfirm.mockReset(); });
  afterEach(() => { Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true }); });

  it('promptOr returns the flag value without prompting', async () => {
    const prompt = vi.fn();
    expect(await promptOr('--name', 'given', prompt)).toBe('given');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('promptOr prompts when interactive and value missing', async () => {
    expect(await promptOr('--name', undefined, async () => 'typed')).toBe('typed');
  });

  it('promptOr throws MissingFlagsError in JSON mode', async () => {
    setJsonMode(true);
    await expect(promptOr('--name', undefined, async () => 'x')).rejects.toBeInstanceOf(MissingFlagsError);
  });

  it('promptOr throws MissingFlagsError without a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    await expect(promptOr('--name', undefined, async () => 'x')).rejects.toBeInstanceOf(MissingFlagsError);
    expect(canPrompt()).toBe(false);
  });

  it('confirmDestruction short-circuits on force', async () => {
    setJsonMode(true);
    expect(await confirmDestruction('VPS v1', 'Delete?', true)).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('confirmDestruction throws ConfirmationRequiredError in JSON mode without force', async () => {
    setJsonMode(true);
    await expect(confirmDestruction('VPS v1', 'Delete?', undefined)).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });

  it('confirmDestruction asks interactively otherwise', async () => {
    mockConfirm.mockResolvedValue(false);
    expect(await confirmDestruction('VPS v1', 'Delete?', undefined)).toBe(false);
    expect(mockConfirm).toHaveBeenCalledWith({ message: 'Delete?', default: false });
  });
});
