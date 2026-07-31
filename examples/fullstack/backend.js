import { defineBackend, defineDatabase, defineTable, s } from "@clank.run/framework";
export const databaseSchema = defineDatabase({
    todos: defineTable({
        title: s.string({
            min: 1,
            max: 160
        }),
        done: s.boolean()
    }).index("by_done", [
        "done"
    ])
});
const documentVersion = s.number({
    integer: true,
    min: 1
});
export const backend = defineBackend({
    schema: databaseSchema
}).functions(({ query, mutation })=>({
        todos: {
            list: query({
                description: "List all todos.",
                args: {},
                handler: ({ db })=>db.table("todos").query().orderBy("_creationTime", "asc").collect()
            }),
            add: mutation({
                description: "Create a todo.",
                args: {
                    title: s.string({
                        min: 1,
                        max: 160,
                        description: "Todo title"
                    })
                },
                agent: {
                    destructive: false
                },
                handler: ({ db }, { title })=>db.table("todos").insert({
                        title,
                        done: false
                    })
            }),
            toggle: mutation({
                description: "Toggle the completion state of one todo.",
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                agent: {
                    destructive: false
                },
                handler: ({ db }, { id, version })=>{
                    const todo = db.table("todos").get(id);
                    return todo ? db.table("todos").patch(id, {
                        done: !todo.done
                    }, {
                        ifVersion: version
                    }) : null;
                }
            }),
            remove: mutation({
                description: "Permanently remove one todo.",
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                agent: {
                    destructive: true
                },
                handler: ({ db }, { id, version })=>db.table("todos").delete(id, {
                        ifVersion: version
                    })
            }),
            clearCompleted: mutation({
                description: "Permanently remove every completed todo.",
                args: {},
                agent: {
                    destructive: true
                },
                handler: ({ db })=>{
                    const completed = db.table("todos").query().where("done", true).collect();
                    for (const todo of completed){
                        db.table("todos").delete(todo._id, {
                            ifVersion: todo._version
                        });
                    }
                    return completed.length;
                }
            })
        }
    }));


//# sourceURL=/home/nearby/Sites/clank/examples/fullstack/backend.ts