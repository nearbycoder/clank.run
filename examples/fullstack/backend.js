import { defineBackend, defineDatabase, defineTable, s } from "clank";
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
                args: {},
                handler: ({ db })=>db.table("todos").query().orderBy("_creationTime", "asc").collect()
            }),
            add: mutation({
                args: {
                    title: s.string({
                        min: 1,
                        max: 160
                    })
                },
                handler: ({ db }, { title })=>db.table("todos").insert({
                        title,
                        done: false
                    })
            }),
            toggle: mutation({
                args: {
                    id: s.id("todos"),
                    version: documentVersion
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
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                handler: ({ db }, { id, version })=>db.table("todos").delete(id, {
                        ifVersion: version
                    })
            }),
            clearCompleted: mutation({
                args: {},
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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svYmFja2VuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUNFLGFBQWEsRUFDYixjQUFjLEVBQ2QsV0FBVyxFQUNYLENBQUMsUUFFSSxRQUFRO0FBRWYsT0FBTyxNQUFNLGlCQUFpQixlQUFlO0lBQzNDLE9BQU8sWUFBWTtRQUNqQixPQUFPLEVBQUUsTUFBTSxDQUFDO1lBQUUsS0FBSztZQUFHLEtBQUs7UUFBSTtRQUNuQyxNQUFNLEVBQUUsT0FBTztJQUNqQixHQUFHLEtBQUssQ0FBQyxXQUFXO1FBQUM7S0FBTztBQUM5QixHQUFHO0FBR0gsTUFBTSxrQkFBa0IsRUFBRSxNQUFNLENBQUM7SUFBRSxTQUFTO0lBQU0sS0FBSztBQUFFO0FBRXpELE9BQU8sTUFBTSxVQUFVLGNBQWM7SUFBRSxRQUFRO0FBQWUsR0FBRyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsR0FBSyxDQUFDO1FBQ25HLE9BQU87WUFDTCxNQUFNLE1BQU07Z0JBQ1YsTUFBTSxDQUFDO2dCQUNQLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxHQUFLLEdBQUcsS0FBSyxDQUFDLFNBQVMsS0FBSyxHQUFHLE9BQU8sQ0FBQyxpQkFBaUIsT0FBTyxPQUFPO1lBQ3hGO1lBQ0EsS0FBSyxTQUFTO2dCQUNaLE1BQU07b0JBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQzt3QkFBRSxLQUFLO3dCQUFHLEtBQUs7b0JBQUk7Z0JBQUc7Z0JBQzlDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEdBQUssR0FBRyxLQUFLLENBQUMsU0FBUyxNQUFNLENBQUM7d0JBQUU7d0JBQU8sTUFBTTtvQkFBTTtZQUNoRjtZQUNBLFFBQVEsU0FBUztnQkFDZixNQUFNO29CQUFFLElBQUksRUFBRSxFQUFFLENBQUM7b0JBQVUsU0FBUztnQkFBZ0I7Z0JBQ3BELFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRTtvQkFDL0IsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFNBQVMsR0FBRyxDQUFDO29CQUNuQyxPQUFPLE9BQ0gsR0FBRyxLQUFLLENBQUMsU0FBUyxLQUFLLENBQUMsSUFBSTt3QkFBRSxNQUFNLENBQUMsS0FBSyxJQUFJO29CQUFDLEdBQUc7d0JBQUUsV0FBVztvQkFBUSxLQUN2RTtnQkFDTjtZQUNGO1lBQ0EsUUFBUSxTQUFTO2dCQUNmLE1BQU07b0JBQUUsSUFBSSxFQUFFLEVBQUUsQ0FBQztvQkFBVSxTQUFTO2dCQUFnQjtnQkFDcEQsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsT0FBTyxFQUFFLEdBQy9CLEdBQUcsS0FBSyxDQUFDLFNBQVMsTUFBTSxDQUFDLElBQUk7d0JBQUUsV0FBVztvQkFBUTtZQUN0RDtZQUNBLGdCQUFnQixTQUFTO2dCQUN2QixNQUFNLENBQUM7Z0JBQ1AsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFO29CQUNkLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQyxTQUFTLEtBQUssR0FBRyxLQUFLLENBQUMsUUFBUSxNQUFNLE9BQU87b0JBQ3ZFLEtBQUssTUFBTSxRQUFRLFVBQVc7d0JBQzVCLEdBQUcsS0FBSyxDQUFDLFNBQVMsTUFBTSxDQUFDLEtBQUssR0FBRyxFQUFFOzRCQUFFLFdBQVcsS0FBSyxRQUFRO3dCQUFDO29CQUNoRTtvQkFDQSxPQUFPLFVBQVUsTUFBTTtnQkFDekI7WUFDRjtRQUNGO0lBQ0YsQ0FBQyxHQUFHIn0=