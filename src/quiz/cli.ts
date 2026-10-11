import { Command } from 'commander';
import { fail, ok } from '../protocol/envelope.js';
import { quizReadCommand, type QuizReadDependencies } from './read/command.js';
export async function parseQuizCLI(args: string[], dependencies: QuizReadDependencies = {}): Promise<void> {
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
  try {
    await program.parseAsync(args, { from: 'user' });
    if (!ran) output(JSON.stringify(fail('quiz.read', 'INVALID_INPUT', 'Use quiz read with --course and --lesson.')));
  } catch (error) {
    if (ran) throw error; // Output sink failures must never cause a second stdout envelope.
    const help = (error as { code?: string }).code === 'commander.helpDisplayed';
    output(JSON.stringify(help ? ok('quiz.read', { usage: 'coursework quiz read --course <id> --lesson <id> [--question <ref>]' })
      : fail('quiz.read', 'INVALID_INPUT', 'Invalid quiz command arguments.', 'Use quiz read --course <id> --lesson <id> [--question <ref>].')));
  }
}
