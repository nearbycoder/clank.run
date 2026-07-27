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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svYmFja2VuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUNFLGFBQWEsRUFDYixjQUFjLEVBQ2QsV0FBVyxFQUNYLENBQUMsUUFFSSx1QkFBdUI7QUFFOUIsT0FBTyxNQUFNLGlCQUFpQixlQUFlO0lBQzNDLE9BQU8sWUFBWTtRQUNqQixPQUFPLEVBQUUsTUFBTSxDQUFDO1lBQUUsS0FBSztZQUFHLEtBQUs7UUFBSTtRQUNuQyxNQUFNLEVBQUUsT0FBTztJQUNqQixHQUFHLEtBQUssQ0FBQyxXQUFXO1FBQUM7S0FBTztBQUM5QixHQUFHO0FBR0gsTUFBTSxrQkFBa0IsRUFBRSxNQUFNLENBQUM7SUFBRSxTQUFTO0lBQU0sS0FBSztBQUFFO0FBRXpELE9BQU8sTUFBTSxVQUFVLGNBQWM7SUFBRSxRQUFRO0FBQWUsR0FBRyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsR0FBSyxDQUFDO1FBQ25HLE9BQU87WUFDTCxNQUFNLE1BQU07Z0JBQ1YsYUFBYTtnQkFDYixNQUFNLENBQUM7Z0JBQ1AsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEdBQUssR0FBRyxLQUFLLENBQUMsU0FBUyxLQUFLLEdBQUcsT0FBTyxDQUFDLGlCQUFpQixPQUFPLE9BQU87WUFDeEY7WUFDQSxLQUFLLFNBQVM7Z0JBQ1osYUFBYTtnQkFDYixNQUFNO29CQUFFLE9BQU8sRUFBRSxNQUFNLENBQUM7d0JBQUUsS0FBSzt3QkFBRyxLQUFLO3dCQUFLLGFBQWE7b0JBQWE7Z0JBQUc7Z0JBQ3pFLE9BQU87b0JBQUUsYUFBYTtnQkFBTTtnQkFDNUIsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsR0FBSyxHQUFHLEtBQUssQ0FBQyxTQUFTLE1BQU0sQ0FBQzt3QkFBRTt3QkFBTyxNQUFNO29CQUFNO1lBQ2hGO1lBQ0EsUUFBUSxTQUFTO2dCQUNmLGFBQWE7Z0JBQ2IsTUFBTTtvQkFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDO29CQUFVLFNBQVM7Z0JBQWdCO2dCQUNwRCxPQUFPO29CQUFFLGFBQWE7Z0JBQU07Z0JBQzVCLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRTtvQkFDL0IsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFNBQVMsR0FBRyxDQUFDO29CQUNuQyxPQUFPLE9BQ0gsR0FBRyxLQUFLLENBQUMsU0FBUyxLQUFLLENBQUMsSUFBSTt3QkFBRSxNQUFNLENBQUMsS0FBSyxJQUFJO29CQUFDLEdBQUc7d0JBQUUsV0FBVztvQkFBUSxLQUN2RTtnQkFDTjtZQUNGO1lBQ0EsUUFBUSxTQUFTO2dCQUNmLGFBQWE7Z0JBQ2IsTUFBTTtvQkFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDO29CQUFVLFNBQVM7Z0JBQWdCO2dCQUNwRCxPQUFPO29CQUFFLGFBQWE7Z0JBQUs7Z0JBQzNCLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxHQUMvQixHQUFHLEtBQUssQ0FBQyxTQUFTLE1BQU0sQ0FBQyxJQUFJO3dCQUFFLFdBQVc7b0JBQVE7WUFDdEQ7WUFDQSxnQkFBZ0IsU0FBUztnQkFDdkIsYUFBYTtnQkFDYixNQUFNLENBQUM7Z0JBQ1AsT0FBTztvQkFBRSxhQUFhO2dCQUFLO2dCQUMzQixTQUFTLENBQUMsRUFBRSxFQUFFLEVBQUU7b0JBQ2QsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFNBQVMsS0FBSyxHQUFHLEtBQUssQ0FBQyxRQUFRLE1BQU0sT0FBTztvQkFDdkUsS0FBSyxNQUFNLFFBQVEsVUFBVzt3QkFDNUIsR0FBRyxLQUFLLENBQUMsU0FBUyxNQUFNLENBQUMsS0FBSyxHQUFHLEVBQUU7NEJBQUUsV0FBVyxLQUFLLFFBQVE7d0JBQUM7b0JBQ2hFO29CQUNBLE9BQU8sVUFBVSxNQUFNO2dCQUN6QjtZQUNGO1FBQ0Y7SUFDRixDQUFDLEdBQUcifQ==