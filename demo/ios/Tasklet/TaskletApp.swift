import SwiftUI

/// A tiny task list used only to exercise Revyl test runs: tap, type, swipe and navigate.
@main
struct TaskletApp: App {
    @State private var store = TaskStore()

    var body: some Scene {
        WindowGroup {
            TaskListView(store: store)
        }
    }
}

struct TaskItem: Identifiable, Hashable {
    let id = UUID()
    var title: String
    var done = false
    var priority = 1
}

@MainActor
@Observable
final class TaskStore {
    var items: [TaskItem] = [
        TaskItem(title: "Buy milk"),
        TaskItem(title: "Call the bank"),
        TaskItem(title: "Water the plants"),
    ]

    var openCount: Int { items.filter { !$0.done }.count }

    func add(_ title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        items.append(TaskItem(title: trimmed))
    }

    func toggle(_ id: TaskItem.ID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].done.toggle()
    }

    func remove(at offsets: IndexSet) {
        items.remove(atOffsets: offsets)
    }
}

struct TaskListView: View {
    @Bindable var store: TaskStore
    @State private var isAdding = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach($store.items) { $item in
                        NavigationLink(value: item.id) {
                            HStack {
                                Button {
                                    store.toggle(item.id)
                                } label: {
                                    Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(item.done ? .green : .secondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(item.done ? "Mark \(item.title) as open" : "Mark \(item.title) as done")
                                .accessibilityIdentifier("tasks.toggle.\(item.title)")
                                Text(item.title)
                                    .strikethrough(item.done)
                            }
                        }
                    }
                    .onDelete(perform: store.remove)
                } footer: {
                    Text("\(store.openCount) open")
                        .accessibilityIdentifier("tasks.footer.count")
                }
            }
            .navigationTitle("Tasks")
            .navigationDestination(for: TaskItem.ID.self) { id in
                if let index = store.items.firstIndex(where: { $0.id == id }) {
                    TaskDetailView(item: $store.items[index])
                }
            }
            .toolbar {
                Button("Add", systemImage: "plus") { isAdding = true }
                    .accessibilityIdentifier("tasks.add.button")
            }
            .sheet(isPresented: $isAdding) {
                AddTaskView { title in
                    store.add(title)
                    isAdding = false
                } onCancel: {
                    isAdding = false
                }
            }
        }
    }
}

struct AddTaskView: View {
    var onSave: (String) -> Void
    var onCancel: () -> Void
    @State private var title = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Task title", text: $title)
                    .accessibilityIdentifier("addTask.title.field")
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("addTask.cancel.button")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(title) }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("addTask.save.button")
                }
            }
        }
    }
}

struct TaskDetailView: View {
    @Binding var item: TaskItem

    var body: some View {
        Form {
            TextField("Title", text: $item.title)
                .accessibilityIdentifier("detail.title.field")
            Toggle("Done", isOn: $item.done)
                .accessibilityIdentifier("detail.done.toggle")
            Stepper("Priority \(item.priority)", value: $item.priority, in: 1...5)
                .accessibilityIdentifier("detail.priority.stepper")
        }
        .navigationTitle(item.title)
    }
}
