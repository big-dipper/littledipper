import { QuickAdd, Tasks, useTasks } from './ActionBar';

/**
 * All your tasks: the box for a new one stays put at the top while the list scrolls under it. Requests people sent
 * you come first, then what's open (soonest first), then what you finished this week.
 */
export default function TasksPage() {
  const { tasks, asks } = useTasks();
  return (
    <div data-screen-label="Tasks" style={{ maxWidth: 680 }}>
      <div className="tasks-head">
        <h1 style={{ marginBottom: 12 }}>Tasks</h1>
        <QuickAdd only="task" />
      </div>
      <div style={{ marginTop: 18 }}>
        <Tasks tasks={tasks} asks={asks} />
      </div>
    </div>
  );
}
