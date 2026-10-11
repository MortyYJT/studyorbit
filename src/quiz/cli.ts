import { readFile, stat } from 'node:fs/promises';
import { recordOwnerAction, proposeQuiz, recordInputFailure, type QuizWriteDependencies } from './proposals.js';
import { CourseworkError } from '../protocol/errors.js';
import { run } from '../protocol/envelope.js';
import { Command } from 'commander';
import { fail, ok } from '../protocol/envelope.js';
import { quizReadCommand, readQuiz, type QuizReadDependencies } from './read/command.js';
export async function parseQuizCLI(args: string[], dependencies: QuizReadDependencies & QuizWriteDependencies = {}): Promise<void> {
  const output = dependencies.stdout ?? console.log;
  const program = new Command().name('coursework').exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let ran = false;
  const quiz = program.command('quiz').description('Read selected Ed quiz questions');
  quiz.command('read').description('Return one bounded model-safe envelope')
    .option('--course <id>', 'Selected Ed course id').option('--lesson <id>', 'Discovered attempt lesson id')
    .option('--question <ref>', 'Narrow to an exact question reference (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .action(async (options: { course?: string; lesson?: string; question: string[] }) => {
      ran = true;
      await quizReadCommand({ course: options.course, lesson: options.lesson, ...(options.question.length ? { questions: options.question } : {}) }, dependencies);
    });
  for (const name of ['policy', 'grant', 'prerequisites', 'propose'] as const) {
    quiz.command(name).description(name === 'propose' ? 'Validate and privately save a cited proposal' : 'Explicit owner recording in a terminal')
      .requiredOption('--input <path>', 'Local JSON input file')
      .action(async (options: { input: string }) => {
        ran = true;
        const loaded = await run(`quiz.${name}`, async () => {
          try {
            if ((await stat(options.input)).size > 4 * 1024 * 1024) throw new CourseworkError('LIMIT_EXCEEDED', 'Quiz input exceeds the private record limit.');
            return JSON.parse(await readFile(options.input, 'utf8')) as unknown;
          } catch (error) {
            throw new CourseworkError(error instanceof CourseworkError ? error.code : 'INVALID_INPUT', 'Quiz input file is unavailable or invalid.');
          }
        });
        const envelope = loaded.ok ? await (name === 'propose' ? proposeQuiz(loaded.data, dependencies) : recordOwnerAction(name, loaded.data, dependencies))
          : await recordInputFailure(name, loaded, dependencies);
        output(JSON.stringify(envelope));
      });
  }
  try {
    await program.parseAsync(args, { from: 'user' });
    if (!ran) output(JSON.stringify(fail('quiz.read', 'INVALID_INPUT', 'Use quiz read with --course and --lesson.')));
  } catch (error) {
    if (ran) throw error; // Output sink failures must never cause a second stdout envelope.
    const help = (error as { code?: string }).code === 'commander.helpDisplayed';
    const name = args[0] === 'quiz' ? args[1] : undefined;
    const writeCommand = (['policy', 'grant', 'prerequisites', 'propose'] as const).find(command => command === name);
    if (writeCommand) {
      output(JSON.stringify(help ? ok(`quiz.${writeCommand}`, { usage: `coursework quiz ${writeCommand} --input <path>` })
        : await recordInputFailure(writeCommand, fail(`quiz.${writeCommand}`, 'INVALID_INPUT', 'Invalid quiz command arguments.'), dependencies)));
    } else {
      output(JSON.stringify(help ? ok('quiz.read', { usage: 'coursework quiz read --course <id> --lesson <id> [--question <ref>]' })
        : await readQuiz(undefined, dependencies)));
    }
  }
}
